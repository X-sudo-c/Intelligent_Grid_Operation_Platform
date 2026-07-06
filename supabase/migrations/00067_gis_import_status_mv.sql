-- Fast steward import queue: materialized classification + cached summary counts.

CREATE OR REPLACE FUNCTION gis.mrid_from_source(p_source TEXT)
RETURNS UUID AS $$
  SELECT extensions.uuid_generate_v5(
    '6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid,
    'giop:' || p_source
  );
$$ LANGUAGE sql IMMUTABLE;

DROP MATERIALIZED VIEW IF EXISTS gis.conductor_import_status;

CREATE MATERIALIZED VIEW gis.conductor_import_status AS
SELECT
  cs.id,
  cs.source_layer,
  cs.source_fid,
  cs.voltage_class,
  cs.circuit_id,
  cs.district,
  cs.region,
  cs.originating_node_id,
  cs.end_node_id,
  cs.length_m,
  ST_X(ST_Centroid(cs.geom)) AS longitude,
  ST_Y(ST_Centroid(cs.geom)) AS latitude,
  gis.conductor_segment_mrid(cs.source_layer, cs.source_fid)::text AS line_mrid,
  CASE
    WHEN cs.originating_node_id IS NULL
      OR cs.end_node_id IS NULL
      OR btrim(cs.originating_node_id) = ''
      OR btrim(cs.end_node_id) = ''
    THEN 'missing_endpoints'
    WHEN src.unique_id IS NULL THEN 'unresolved_originating'
    WHEN tgt.unique_id IS NULL THEN 'unresolved_end'
    WHEN src.mrid = tgt.mrid THEN 'same_endpoint'
    WHEN cs.geom IS NULL
      OR GeometryType(ST_Force2D(cs.geom)) NOT IN ('LINESTRING', 'MULTILINESTRING')
    THEN 'invalid_geom'
    WHEN als.mrid IS NOT NULL THEN 'already_promoted'
    ELSE 'eligible_unpromoted'
  END AS reason
FROM gis.conductor_segments cs
LEFT JOIN gis.unique_id_lookup src
  ON src.unique_id = btrim(cs.originating_node_id)
LEFT JOIN gis.unique_id_lookup tgt
  ON tgt.unique_id = btrim(cs.end_node_id)
LEFT JOIN public.ac_line_segments als
  ON als.mrid = gis.conductor_segment_mrid(cs.source_layer, cs.source_fid)
WITH NO DATA;

CREATE UNIQUE INDEX idx_gis_conductor_import_status_id
  ON gis.conductor_import_status (id);

CREATE INDEX idx_gis_conductor_import_status_reason
  ON gis.conductor_import_status (reason);

CREATE INDEX idx_gis_conductor_import_status_district_reason
  ON gis.conductor_import_status (district, reason)
  WHERE district IS NOT NULL AND btrim(district) <> '';

CREATE TABLE IF NOT EXISTS gis.import_pipeline_stats (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  conductor_segments BIGINT NOT NULL DEFAULT 0,
  master_lines BIGINT NOT NULL DEFAULT 0,
  total_unpromoted BIGINT NOT NULL DEFAULT 0,
  by_reason JSONB NOT NULL DEFAULT '{}'::jsonb
);

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

  INSERT INTO gis.import_pipeline_stats (
    id, refreshed_at, conductor_segments, master_lines, total_unpromoted, by_reason
  ) VALUES (
    1, NOW(), v_conductors, v_master, v_total_unpromoted, v_by_reason
  )
  ON CONFLICT (id) DO UPDATE SET
    refreshed_at = EXCLUDED.refreshed_at,
    conductor_segments = EXCLUDED.conductor_segments,
    master_lines = EXCLUDED.master_lines,
    total_unpromoted = EXCLUDED.total_unpromoted,
    by_reason = EXCLUDED.by_reason;

  RETURN jsonb_build_object(
    'refreshed_at', NOW(),
    'duration_ms', (EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) * 1000)::bigint,
    'conductor_segments', v_conductors,
    'master_lines', v_master,
    'total_unpromoted', v_total_unpromoted,
    'by_reason', v_by_reason
  );
END;
$$;

CREATE OR REPLACE FUNCTION gis.post_import_refresh()
RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'asset_id_map', gis.rebuild_asset_id_map(),
    'conductors', gis.rebuild_conductor_segments(),
    'unique_id_lookup', gis.rebuild_unique_id_lookup(),
    'conductor_snap', gis.snap_eligible_conductor_endpoints(),
    'cim_nodes', gis.promote_transformers_to_cim(),
    'import_status', gis.refresh_conductor_import_status()
  );
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION gis.promote_topology_to_cim()
RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'unique_id_lookup', gis.rebuild_unique_id_lookup(),
    'support_structures', gis.promote_support_structures_to_cim(),
    'conductor_snap', gis.snap_eligible_conductor_endpoints(),
    'conductors', gis.promote_conductors_to_cim(),
    'import_status', gis.refresh_conductor_import_status()
  );
$$ LANGUAGE sql;

GRANT SELECT ON gis.conductor_import_status TO anon, authenticated, service_role;
GRANT SELECT ON gis.import_pipeline_stats TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION gis.refresh_conductor_import_status() TO service_role;
