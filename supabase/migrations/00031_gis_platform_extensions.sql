-- GIS platform extensions: search, job queues, topology QA, embeddings, import/export storage.

CREATE SCHEMA IF NOT EXISTS extensions;

-- Fuzzy text search (asset names, districts, feeders).
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- Scheduled maintenance (job cleanup, future reconcile hooks).
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Durable queues for async GIS import/export workers.
CREATE EXTENSION IF NOT EXISTS pgmq;

-- Topology validation after bulk GIS promote/import.
CREATE EXTENSION IF NOT EXISTS postgis_topology;

-- Embeddings for AI / document search (insights, CIM mapping register).
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- Import / export job registry (metadata + status; payloads in pgmq + Storage)
-- ---------------------------------------------------------------------------

DO $types$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'gis_transfer_direction' AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.gis_transfer_direction AS ENUM ('import', 'export');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'gis_transfer_status' AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.gis_transfer_status AS ENUM (
      'pending',
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled'
    );
  END IF;
END;
$types$;

CREATE TABLE IF NOT EXISTS public.gis_transfer_jobs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  direction       public.gis_transfer_direction NOT NULL,
  format          TEXT NOT NULL,
  status          public.gis_transfer_status NOT NULL DEFAULT 'pending',
  storage_bucket  TEXT,
  storage_path    TEXT,
  clip_district   TEXT,
  clip_region     TEXT,
  clip_west       DOUBLE PRECISION,
  clip_south      DOUBLE PRECISION,
  clip_east       DOUBLE PRECISION,
  clip_north      DOUBLE PRECISION,
  layers          TEXT[] NOT NULL DEFAULT '{}',
  feature_count   BIGINT,
  error_message   TEXT,
  requested_by    TEXT,
  pgmq_msg_id     BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gis_transfer_jobs_status_created
  ON public.gis_transfer_jobs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gis_transfer_jobs_district
  ON public.gis_transfer_jobs (clip_district)
  WHERE clip_district IS NOT NULL;

COMMENT ON TABLE public.gis_transfer_jobs IS
  'Async GIS import/export jobs; files in Supabase Storage, work items in pgmq.';

-- pgmq queues for sync-service workers
DO $pgmq$
BEGIN
  PERFORM pgmq.create('gis_import_jobs');
EXCEPTION
  WHEN duplicate_object OR OTHERS THEN
    NULL;
END;
$pgmq$;

DO $pgmq$
BEGIN
  PERFORM pgmq.create('gis_export_jobs');
EXCEPTION
  WHEN duplicate_object OR OTHERS THEN
    NULL;
END;
$pgmq$;

-- ---------------------------------------------------------------------------
-- ECG admin boundaries (GPKG import fills this; stub for fresh schema-only DBs)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS gis.ecg_admin_boundaries (
  fid int4 PRIMARY KEY,
  district text,
  region text,
  geom geometry(MultiPolygon, 4326)
);

CREATE INDEX IF NOT EXISTS idx_ecg_admin_boundaries_geom
  ON gis.ecg_admin_boundaries USING GIST (geom);

-- ---------------------------------------------------------------------------
-- pg_trgm search indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_identified_objects_name_trgm
  ON public.identified_objects
  USING gin (name extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_staging_identified_objects_name_trgm
  ON staging.identified_objects
  USING gin (name extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_ecg_admin_boundaries_district_trgm
  ON gis.ecg_admin_boundaries
  USING gin (district extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_ecg_admin_boundaries_region_trgm
  ON gis.ecg_admin_boundaries
  USING gin (region extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Supabase Storage buckets (import / export artifacts)
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  (
    'gis-imports',
    'gis-imports',
    FALSE,
    2147483648,
    ARRAY[
      'application/geopackage+sqlite3',
      'application/x-sqlite3',
      'application/json',
      'application/geo+json',
      'application/zip',
      'application/x-zip-compressed',
      'application/vnd.google-earth.kml+xml',
      'application/vnd.google-earth.kmz',
      'application/octet-stream'
    ]::text[]
  ),
  (
    'gis-exports',
    'gis-exports',
    FALSE,
    2147483648,
    ARRAY[
      'application/geopackage+sqlite3',
      'application/x-sqlite3',
      'application/json',
      'application/geo+json',
      'application/zip',
      'application/x-zip-compressed',
      'application/vnd.google-earth.kml+xml',
      'application/octet-stream'
    ]::text[]
  )
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Authenticated users may upload imports and read exports; service_role bypasses RLS.
DROP POLICY IF EXISTS gis_imports_authenticated_insert ON storage.objects;
DROP POLICY IF EXISTS gis_imports_authenticated_select ON storage.objects;
DROP POLICY IF EXISTS gis_exports_authenticated_select ON storage.objects;
DROP POLICY IF EXISTS gis_exports_service_insert ON storage.objects;

CREATE POLICY gis_imports_authenticated_insert
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'gis-imports');

CREATE POLICY gis_imports_authenticated_select
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'gis-imports');

CREATE POLICY gis_exports_authenticated_select
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'gis-exports');

CREATE POLICY gis_exports_service_insert
  ON storage.objects FOR INSERT TO service_role
  WITH CHECK (bucket_id IN ('gis-imports', 'gis-exports'));

-- ---------------------------------------------------------------------------
-- pg_cron: purge completed transfer jobs older than 30 days (daily 03:00 UTC)
-- ---------------------------------------------------------------------------

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('gis_transfer_jobs_cleanup');
    EXCEPTION
      WHEN OTHERS THEN
        NULL;
    END;

    PERFORM cron.schedule(
      'gis_transfer_jobs_cleanup',
      '0 3 * * *',
      $job$
        DELETE FROM public.gis_transfer_jobs
        WHERE status IN ('completed', 'cancelled')
          AND completed_at IS NOT NULL
          AND completed_at < NOW() - INTERVAL '30 days';
      $job$
    );
  END IF;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'pg_cron schema not ready — skip gis_transfer_jobs_cleanup schedule';
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END;
$cron$;

GRANT SELECT, INSERT, UPDATE ON public.gis_transfer_jobs TO authenticated, service_role;
GRANT USAGE ON TYPE public.gis_transfer_direction TO authenticated, service_role;
GRANT USAGE ON TYPE public.gis_transfer_status TO authenticated, service_role;

DO $realtime$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.gis_transfer_jobs;
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END;
$realtime$;
