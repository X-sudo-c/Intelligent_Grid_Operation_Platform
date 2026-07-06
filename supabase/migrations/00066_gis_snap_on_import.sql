-- Conservative snap-on-import: rebuild conductor geometry from resolved endpoint nodes.
-- Also exposes unpromoted segment classification for steward import queue.

CREATE INDEX IF NOT EXISTS idx_gis_conductor_segments_district
  ON gis.conductor_segments (district)
  WHERE district IS NOT NULL AND btrim(district) <> '';

CREATE OR REPLACE FUNCTION gis.snap_eligible_conductor_endpoints(
  p_tolerance_m DOUBLE PRECISION DEFAULT 1.0
)
RETURNS JSONB AS $$
DECLARE
  v_snapped BIGINT := 0;
  v_already_aligned BIGINT := 0;
  v_no_geom BIGINT := 0;
  v_unresolved BIGINT := 0;
BEGIN
  WITH resolved AS (
    SELECT
      cs.id,
      src.geom AS src_geom,
      tgt.geom AS tgt_geom,
      gis.as_linestring(cs.geom) AS line_geom
    FROM gis.conductor_segments cs
    INNER JOIN gis.unique_id_lookup src
      ON src.unique_id = btrim(cs.originating_node_id)
    INNER JOIN gis.unique_id_lookup tgt
      ON tgt.unique_id = btrim(cs.end_node_id)
    WHERE cs.originating_node_id IS NOT NULL
      AND cs.end_node_id IS NOT NULL
      AND btrim(cs.originating_node_id) <> ''
      AND btrim(cs.end_node_id) <> ''
      AND src.mrid IS DISTINCT FROM tgt.mrid
  ),
  classified AS (
    SELECT
      r.id,
      ST_MakeLine(r.src_geom, r.tgt_geom)::geometry(LineString, 4326) AS snapped_geom,
      CASE
        WHEN r.line_geom IS NULL THEN 'snap'
        WHEN ST_DWithin(
               ST_StartPoint(r.line_geom)::geography,
               r.src_geom::geography,
               p_tolerance_m
             )
         AND ST_DWithin(
               ST_EndPoint(r.line_geom)::geography,
               r.tgt_geom::geography,
               p_tolerance_m
             )
        THEN 'aligned'
        ELSE 'snap'
      END AS action
    FROM resolved r
  )
  UPDATE gis.conductor_segments cs
  SET geom = c.snapped_geom
  FROM classified c
  WHERE cs.id = c.id
    AND c.action = 'snap';

  GET DIAGNOSTICS v_snapped = ROW_COUNT;

  WITH resolved AS (
    SELECT
      cs.id,
      src.geom AS src_geom,
      tgt.geom AS tgt_geom,
      gis.as_linestring(cs.geom) AS line_geom
    FROM gis.conductor_segments cs
    INNER JOIN gis.unique_id_lookup src
      ON src.unique_id = btrim(cs.originating_node_id)
    INNER JOIN gis.unique_id_lookup tgt
      ON tgt.unique_id = btrim(cs.end_node_id)
    WHERE cs.originating_node_id IS NOT NULL
      AND cs.end_node_id IS NOT NULL
      AND btrim(cs.originating_node_id) <> ''
      AND btrim(cs.end_node_id) <> ''
      AND src.mrid IS DISTINCT FROM tgt.mrid
  ),
  classified AS (
    SELECT
      CASE
        WHEN r.line_geom IS NULL THEN 'snap'
        WHEN ST_DWithin(
               ST_StartPoint(r.line_geom)::geography,
               r.src_geom::geography,
               p_tolerance_m
             )
         AND ST_DWithin(
               ST_EndPoint(r.line_geom)::geography,
               r.tgt_geom::geography,
               p_tolerance_m
             )
        THEN 'aligned'
        ELSE 'snap'
      END AS action
    FROM resolved r
  )
  SELECT
    COUNT(*) FILTER (WHERE action = 'aligned'),
    COUNT(*) FILTER (WHERE action = 'no_geom')
  INTO v_already_aligned, v_no_geom
  FROM classified;

  SELECT COUNT(*) INTO v_unresolved
  FROM gis.conductor_segments cs
  WHERE cs.originating_node_id IS NULL
     OR cs.end_node_id IS NULL
     OR btrim(cs.originating_node_id) = ''
     OR btrim(cs.end_node_id) = ''
     OR NOT EXISTS (
       SELECT 1
       FROM gis.unique_id_lookup src
       WHERE src.unique_id = btrim(cs.originating_node_id)
     )
     OR NOT EXISTS (
       SELECT 1
       FROM gis.unique_id_lookup tgt
       WHERE tgt.unique_id = btrim(cs.end_node_id)
     )
     OR EXISTS (
       SELECT 1
       FROM gis.unique_id_lookup src
       JOIN gis.unique_id_lookup tgt
         ON tgt.unique_id = btrim(cs.end_node_id)
       WHERE src.unique_id = btrim(cs.originating_node_id)
         AND src.mrid = tgt.mrid
     );

  RETURN jsonb_build_object(
    'segments_snapped', v_snapped,
    'segments_already_aligned', v_already_aligned,
    'segments_no_geom', v_no_geom,
    'segments_unresolved', v_unresolved,
    'tolerance_m', p_tolerance_m
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION gis.snap_eligible_conductor_endpoints IS
  'Rebuild gis.conductor_segments geometry from resolved unique_id endpoints (conservative 2-point snap).';

CREATE OR REPLACE FUNCTION gis.conductor_segment_unpromoted_reason(
  p_originating_node_id TEXT,
  p_end_node_id TEXT,
  p_geom geometry,
  p_source_layer TEXT,
  p_source_fid BIGINT
)
RETURNS TEXT AS $$
DECLARE
  v_line_mrid UUID;
BEGIN
  IF p_originating_node_id IS NULL
     OR p_end_node_id IS NULL
     OR btrim(p_originating_node_id) = ''
     OR btrim(p_end_node_id) = ''
  THEN
    RETURN 'missing_endpoints';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM gis.unique_id_lookup u
    WHERE u.unique_id = btrim(p_originating_node_id)
  ) THEN
    RETURN 'unresolved_originating';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM gis.unique_id_lookup u
    WHERE u.unique_id = btrim(p_end_node_id)
  ) THEN
    RETURN 'unresolved_end';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gis.unique_id_lookup src
    JOIN gis.unique_id_lookup tgt
      ON tgt.unique_id = btrim(p_end_node_id)
    WHERE src.unique_id = btrim(p_originating_node_id)
      AND src.mrid = tgt.mrid
  ) THEN
    RETURN 'same_endpoint';
  END IF;

  IF gis.as_linestring(p_geom) IS NULL THEN
    RETURN 'invalid_geom';
  END IF;

  v_line_mrid := gis.conductor_segment_mrid(p_source_layer, p_source_fid);
  IF EXISTS (
    SELECT 1
    FROM public.ac_line_segments als
    WHERE als.mrid = v_line_mrid
  ) THEN
    RETURN 'already_promoted';
  END IF;

  RETURN 'eligible_unpromoted';
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION gis.post_import_refresh()
RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'asset_id_map', gis.rebuild_asset_id_map(),
    'conductors', gis.rebuild_conductor_segments(),
    'unique_id_lookup', gis.rebuild_unique_id_lookup(),
    'conductor_snap', gis.snap_eligible_conductor_endpoints(),
    'cim_nodes', gis.promote_transformers_to_cim()
  );
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION gis.promote_topology_to_cim()
RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'unique_id_lookup', gis.rebuild_unique_id_lookup(),
    'support_structures', gis.promote_support_structures_to_cim(),
    'conductor_snap', gis.snap_eligible_conductor_endpoints(),
    'conductors', gis.promote_conductors_to_cim()
  );
$$ LANGUAGE sql;

GRANT EXECUTE ON FUNCTION gis.snap_eligible_conductor_endpoints(DOUBLE PRECISION) TO service_role;
GRANT EXECUTE ON FUNCTION gis.conductor_segment_unpromoted_reason(TEXT, TEXT, geometry, TEXT, BIGINT)
  TO anon, authenticated, service_role;
