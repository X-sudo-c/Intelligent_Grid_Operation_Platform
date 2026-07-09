-- Speed up GIS import queue:
-- 1) Set-based endpoint diagnostics (LEFT JOIN) instead of per-row classify EXISTS.
-- 2) Cache national rollup on gis.import_pipeline_stats (filled during MV refresh).
-- 3) Partial index for unpromoted steward list ORDER BY.

ALTER TABLE gis.import_pipeline_stats
  ADD COLUMN IF NOT EXISTS endpoint_diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_gis_conductor_import_status_unpromoted_list
  ON gis.conductor_import_status (district NULLS LAST, source_layer, source_fid)
  WHERE reason <> 'already_promoted';

-- Bulk classification used by refresh + live district-scoped reads.
CREATE OR REPLACE FUNCTION gis.compute_endpoint_diagnostics_summary(
  p_district TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = gis, public
AS $$
DECLARE
  v_orig JSONB;
  v_end JSONB;
  v_total BIGINT;
  v_district TEXT := NULLIF(btrim(p_district), '');
BEGIN
  WITH unpromoted AS MATERIALIZED (
    SELECT
      NULLIF(btrim(s.originating_node_id), '') AS orig_id,
      NULLIF(btrim(s.end_node_id), '') AS end_id
    FROM gis.conductor_import_status s
    WHERE s.reason <> 'already_promoted'
      AND (v_district IS NULL OR s.district = v_district)
  ),
  classified AS MATERIALIZED (
    SELECT
      CASE
        WHEN u.orig_id IS NULL THEN 'missing'
        WHEN lo.unique_id IS NOT NULL THEN 'pole_resolved'
        WHEN ao.alias IS NOT NULL THEN 'pole_alias_pending'
        WHEN gis.is_customer_equipment_id(u.orig_id) THEN 'customer_equipment'
        WHEN u.orig_id ~ '^P[0-9]+$' OR length(u.orig_id) <= 4 THEN 'generic_short_id'
        WHEN u.orig_id ~ '^P[0-9]+/' OR u.orig_id ~ '^[A-Za-z]+[0-9]+/' THEN 'pole_id_unmatched'
        ELSE 'other_unmatched'
      END AS orig_cls,
      CASE
        WHEN u.end_id IS NULL THEN 'missing'
        WHEN le.unique_id IS NOT NULL THEN 'pole_resolved'
        WHEN ae.alias IS NOT NULL THEN 'pole_alias_pending'
        WHEN gis.is_customer_equipment_id(u.end_id) THEN 'customer_equipment'
        WHEN u.end_id ~ '^P[0-9]+$' OR length(u.end_id) <= 4 THEN 'generic_short_id'
        WHEN u.end_id ~ '^P[0-9]+/' OR u.end_id ~ '^[A-Za-z]+[0-9]+/' THEN 'pole_id_unmatched'
        ELSE 'other_unmatched'
      END AS end_cls
    FROM unpromoted u
    LEFT JOIN gis.unique_id_lookup lo ON lo.unique_id = u.orig_id
    LEFT JOIN gis.endpoint_id_alias ao ON ao.alias = u.orig_id
    LEFT JOIN gis.unique_id_lookup le ON le.unique_id = u.end_id
    LEFT JOIN gis.endpoint_id_alias ae ON ae.alias = u.end_id
  )
  SELECT
    (SELECT COUNT(*)::bigint FROM classified),
    COALESCE(
      (SELECT jsonb_object_agg(cls, cnt ORDER BY cnt DESC)
       FROM (SELECT orig_cls AS cls, COUNT(*)::bigint AS cnt FROM classified GROUP BY 1) o),
      '{}'::jsonb
    ),
    COALESCE(
      (SELECT jsonb_object_agg(cls, cnt ORDER BY cnt DESC)
       FROM (SELECT end_cls AS cls, COUNT(*)::bigint AS cnt FROM classified GROUP BY 1) e),
      '{}'::jsonb
    )
  INTO v_total, v_orig, v_end;

  RETURN jsonb_build_object(
    'unpromoted_segments', COALESCE(v_total, 0),
    'district', v_district,
    'originating', COALESCE(v_orig, '{}'::jsonb),
    'end', COALESCE(v_end, '{}'::jsonb),
    'endpoint_alias_rows', (SELECT COUNT(*) FROM gis.endpoint_id_alias),
    'lookup_rows', (SELECT COUNT(*) FROM gis.unique_id_lookup),
    'refreshed_at', NOW(),
    'source', 'live'
  );
END;
$$;

CREATE OR REPLACE FUNCTION gis.endpoint_diagnostics_summary(
  p_district TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = gis, public
AS $$
DECLARE
  v_district TEXT := NULLIF(btrim(p_district), '');
  v_cached JSONB;
  v_live JSONB;
BEGIN
  -- National rollup is refreshed with conductor_import_status; serve instantly.
  IF v_district IS NULL THEN
    SELECT s.endpoint_diagnostics
    INTO v_cached
    FROM gis.import_pipeline_stats s
    WHERE s.id = 1
      AND s.endpoint_diagnostics ? 'originating'
      AND s.endpoint_diagnostics ? 'end';

    IF v_cached IS NOT NULL AND v_cached <> '{}'::jsonb THEN
      RETURN v_cached || jsonb_build_object('source', 'cached');
    END IF;

    -- Cache miss: compute once and persist so subsequent opens stay cheap.
    v_live := gis.compute_endpoint_diagnostics_summary(NULL);
    UPDATE gis.import_pipeline_stats
    SET endpoint_diagnostics = v_live || jsonb_build_object('source', 'lazy_cache')
    WHERE id = 1;
    IF FOUND THEN
      RETURN v_live || jsonb_build_object('source', 'lazy_cache');
    END IF;
    RETURN v_live;
  END IF;

  RETURN gis.compute_endpoint_diagnostics_summary(v_district);
END;
$$;

CREATE OR REPLACE FUNCTION gis.refresh_conductor_import_status()
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, gis, extensions
AS $$
DECLARE
  v_started TIMESTAMPTZ := clock_timestamp();
  v_by_reason JSONB;
  v_total_unpromoted BIGINT;
  v_conductors BIGINT;
  v_master BIGINT;
  v_endpoint_diagnostics JSONB;
BEGIN
  REFRESH MATERIALIZED VIEW gis.conductor_import_status;

  SELECT COUNT(*) INTO v_conductors FROM gis.conductor_segments;
  SELECT COUNT(*) INTO v_master FROM public.ac_line_segments;

  SELECT
    COALESCE(jsonb_object_agg(reason, cnt), '{}'::jsonb),
    COALESCE(SUM(cnt), 0)
  INTO v_by_reason, v_total_unpromoted
  FROM (
    SELECT reason, COUNT(*)::bigint AS cnt
    FROM gis.conductor_import_status
    WHERE reason <> 'already_promoted'
    GROUP BY reason
  ) s;

  -- Compute once during refresh so the import-queue panel reads cache.
  v_endpoint_diagnostics := gis.compute_endpoint_diagnostics_summary(NULL);
  v_endpoint_diagnostics := v_endpoint_diagnostics || jsonb_build_object('source', 'pipeline_refresh');

  INSERT INTO gis.import_pipeline_stats (
    id, refreshed_at, conductor_segments, master_lines, total_unpromoted, by_reason,
    endpoint_diagnostics
  ) VALUES (
    1, NOW(), v_conductors, v_master, v_total_unpromoted, v_by_reason,
    v_endpoint_diagnostics
  )
  ON CONFLICT (id) DO UPDATE SET
    refreshed_at = EXCLUDED.refreshed_at,
    conductor_segments = EXCLUDED.conductor_segments,
    master_lines = EXCLUDED.master_lines,
    total_unpromoted = EXCLUDED.total_unpromoted,
    by_reason = EXCLUDED.by_reason,
    endpoint_diagnostics = EXCLUDED.endpoint_diagnostics;

  RETURN jsonb_build_object(
    'refreshed_at', NOW(),
    'duration_ms', (EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) * 1000)::bigint,
    'conductor_segments', v_conductors,
    'master_lines', v_master,
    'total_unpromoted', v_total_unpromoted,
    'by_reason', v_by_reason,
    'endpoint_diagnostics_cached', TRUE
  );
END;
$$;

-- Optional: backfill national cache if MV already exists (can take a bit on large queues).
-- Safe to skip — first API call (or next import-status refresh) will lazy-cache.
DO $$
DECLARE
  v_diag JSONB;
  v_unpromoted BIGINT;
BEGIN
  SELECT total_unpromoted INTO v_unpromoted
  FROM gis.import_pipeline_stats WHERE id = 1;

  -- Avoid multi-minute migration on huge national queues; lazy-cache on first read instead.
  IF COALESCE(v_unpromoted, 0) > 200000 THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM gis.import_pipeline_stats
    WHERE id = 1
      AND (endpoint_diagnostics = '{}'::jsonb OR NOT (endpoint_diagnostics ? 'originating'))
  ) AND EXISTS (
    SELECT 1 FROM pg_matviews
    WHERE schemaname = 'gis' AND matviewname = 'conductor_import_status'
  ) THEN
    v_diag := gis.compute_endpoint_diagnostics_summary(NULL);
    UPDATE gis.import_pipeline_stats
    SET endpoint_diagnostics = v_diag || jsonb_build_object('source', 'migration_backfill')
    WHERE id = 1;
  END IF;
EXCEPTION
  WHEN undefined_table THEN
    NULL;
END $$;

GRANT EXECUTE ON FUNCTION gis.compute_endpoint_diagnostics_summary(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gis.endpoint_diagnostics_summary(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gis.refresh_conductor_import_status() TO service_role;
