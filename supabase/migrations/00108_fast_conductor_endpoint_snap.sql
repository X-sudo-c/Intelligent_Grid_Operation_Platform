-- Faster national endpoint snap for steward "Run endpoint snap".
-- Bottlenecks addressed:
-- 1) Per-row LATERAL gis.resolve_endpoint() → set-based district/global lookup joins
-- 2) Repeated geography casts → ST_DistanceSphere (meters, no geography cast)
-- 3) Second full-table unresolved scan with endpoint_is_resolved → cheap anti-join
-- 4) Skip already-promoted lines (geometry snap does not change import-status reasons)

CREATE OR REPLACE FUNCTION gis.snap_eligible_conductor_endpoints(
  p_tolerance_m DOUBLE PRECISION DEFAULT 1.0,
  p_max_move_m DOUBLE PRECISION DEFAULT 150.0
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = gis, public
AS $$
DECLARE
  v_snapped BIGINT := 0;
  v_already_aligned BIGINT := 0;
  v_no_geom BIGINT := 0;
  v_unresolved BIGINT := 0;
  v_span_rejected BIGINT := 0;
  v_move_rejected BIGINT := 0;
  v_started TIMESTAMPTZ := clock_timestamp();
BEGIN
  DROP TABLE IF EXISTS _snap_classified;
  CREATE TEMP TABLE _snap_classified ON COMMIT DROP AS
  WITH candidates AS (
    SELECT
      cs.id,
      cs.voltage_class,
      NULLIF(btrim(cs.district), '') AS district,
      NULLIF(btrim(cs.originating_node_id), '') AS orig_uid,
      NULLIF(btrim(cs.end_node_id), '') AS end_uid,
      gis.as_linestring(cs.geom) AS raw_line
    FROM gis.conductor_import_status s
    JOIN gis.conductor_segments cs ON cs.id = s.id
    WHERE s.reason <> 'already_promoted'
      AND cs.originating_node_id IS NOT NULL
      AND cs.end_node_id IS NOT NULL
      AND btrim(cs.originating_node_id) <> ''
      AND btrim(cs.end_node_id) <> ''
  ),
  resolved AS (
    SELECT
      c.id,
      c.voltage_class,
      c.raw_line,
      COALESCE(ds.geom, gs.geom) AS src_geom,
      COALESCE(dt.geom, gt.geom) AS tgt_geom
    FROM candidates c
    LEFT JOIN gis.district_endpoint_lookup ds
      ON c.district IS NOT NULL
     AND ds.district = c.district
     AND ds.unique_id = c.orig_uid
    LEFT JOIN gis.district_endpoint_lookup dt
      ON c.district IS NOT NULL
     AND dt.district = c.district
     AND dt.unique_id = c.end_uid
    LEFT JOIN gis.unique_id_lookup gs
      ON ds.mrid IS NULL
     AND gs.unique_id = c.orig_uid
    LEFT JOIN gis.unique_id_lookup gt
      ON dt.mrid IS NULL
     AND gt.unique_id = c.end_uid
    WHERE COALESCE(ds.mrid, gs.mrid) IS NOT NULL
      AND COALESCE(dt.mrid, gt.mrid) IS NOT NULL
      AND COALESCE(ds.mrid, gs.mrid) IS DISTINCT FROM COALESCE(dt.mrid, gt.mrid)
  ),
  oriented AS (
    SELECT
      r.*,
      ST_DistanceSphere(r.src_geom, r.tgt_geom) AS span_m,
      CASE
        WHEN r.raw_line IS NULL THEN NULL
        WHEN ST_DistanceSphere(ST_StartPoint(r.raw_line), r.src_geom)
           + ST_DistanceSphere(ST_EndPoint(r.raw_line), r.tgt_geom)
          <= ST_DistanceSphere(ST_StartPoint(r.raw_line), r.tgt_geom)
           + ST_DistanceSphere(ST_EndPoint(r.raw_line), r.src_geom)
        THEN r.raw_line
        ELSE ST_Reverse(r.raw_line)
      END AS line_geom
    FROM resolved r
  ),
  measured AS (
    SELECT
      o.*,
      CASE WHEN o.line_geom IS NULL THEN NULL
        ELSE ST_DistanceSphere(ST_StartPoint(o.line_geom), o.src_geom)
      END AS start_move_m,
      CASE WHEN o.line_geom IS NULL THEN NULL
        ELSE ST_DistanceSphere(ST_EndPoint(o.line_geom), o.tgt_geom)
      END AS end_move_m
    FROM oriented o
  )
  SELECT
    m.id,
    CASE
      WHEN m.line_geom IS NULL THEN NULL
      WHEN m.span_m > gis.max_conductor_snap_span_m(m.voltage_class) THEN NULL
      WHEN m.start_move_m <= p_tolerance_m AND m.end_move_m <= p_tolerance_m THEN NULL
      WHEN m.start_move_m > p_max_move_m OR m.end_move_m > p_max_move_m THEN NULL
      ELSE ST_SetPoint(
             ST_SetPoint(m.line_geom, 0, m.src_geom),
             ST_NPoints(m.line_geom) - 1,
             m.tgt_geom
           )
    END AS snapped_geom,
    CASE
      WHEN m.line_geom IS NULL THEN 'no_geom'
      WHEN m.span_m > gis.max_conductor_snap_span_m(m.voltage_class) THEN 'span_rejected'
      WHEN m.start_move_m <= p_tolerance_m AND m.end_move_m <= p_tolerance_m THEN 'aligned'
      WHEN m.start_move_m > p_max_move_m OR m.end_move_m > p_max_move_m THEN 'move_rejected'
      ELSE 'snap'
    END AS action
  FROM measured m;

  UPDATE gis.conductor_segments cs
  SET geom = c.snapped_geom
  FROM _snap_classified c
  WHERE cs.id = c.id
    AND c.action = 'snap'
    AND c.snapped_geom IS NOT NULL;

  GET DIAGNOSTICS v_snapped = ROW_COUNT;

  SELECT
    COUNT(*) FILTER (WHERE action = 'aligned'),
    COUNT(*) FILTER (WHERE action = 'no_geom'),
    COUNT(*) FILTER (WHERE action = 'span_rejected'),
    COUNT(*) FILTER (WHERE action = 'move_rejected')
  INTO v_already_aligned, v_no_geom, v_span_rejected, v_move_rejected
  FROM _snap_classified;

  -- Segments that never entered the classified set (missing/unresolved/same-end).
  SELECT COUNT(*) INTO v_unresolved
  FROM gis.conductor_import_status s
  WHERE s.reason <> 'already_promoted'
    AND NOT EXISTS (SELECT 1 FROM _snap_classified c WHERE c.id = s.id);

  DROP TABLE IF EXISTS _snap_classified;

  RETURN jsonb_build_object(
    'segments_snapped', v_snapped,
    'segments_already_aligned', v_already_aligned,
    'segments_no_geom', v_no_geom,
    'segments_unresolved', v_unresolved,
    'segments_span_rejected', v_span_rejected,
    'segments_move_rejected', v_move_rejected,
    'tolerance_m', p_tolerance_m,
    'max_move_m', p_max_move_m,
    'duration_ms', (EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) * 1000)::bigint
  );
END;
$$;

COMMENT ON FUNCTION gis.snap_eligible_conductor_endpoints(DOUBLE PRECISION, DOUBLE PRECISION) IS
  'Snap resolved unpromoted conductor endpoints onto node geometry (set-based; skips already-promoted).';

GRANT EXECUTE ON FUNCTION gis.snap_eligible_conductor_endpoints(DOUBLE PRECISION, DOUBLE PRECISION) TO service_role;
