-- Geometry-first endpoint repair: district-scoped node lookup, snap-on-apply, alignment preview.

CREATE OR REPLACE FUNCTION gis.district_endpoint_geom(
  p_district TEXT,
  p_uid TEXT
)
RETURNS GEOMETRY(Point, 4326)
LANGUAGE sql
STABLE
SET search_path = gis, public
AS $$
  SELECT l.geom
  FROM gis.district_endpoint_lookup l
  WHERE l.district = NULLIF(btrim(p_district), '')
    AND l.unique_id = NULLIF(btrim(p_uid), '')
  LIMIT 1;
$$;

COMMENT ON FUNCTION gis.district_endpoint_geom(TEXT, TEXT) IS
  'District-scoped endpoint coordinates for geometry-first topology repair (no national fallback).';

CREATE OR REPLACE FUNCTION gis.preview_endpoint_topology_alignment(
  p_segment_id BIGINT,
  p_district TEXT,
  p_proposed_from TEXT,
  p_proposed_to TEXT,
  p_topology_tolerance_m DOUBLE PRECISION DEFAULT 1.0,
  p_max_snap_move_m DOUBLE PRECISION DEFAULT 150.0
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = gis, public
AS $$
DECLARE
  v_district TEXT := NULLIF(btrim(p_district), '');
  v_from_uid TEXT := NULLIF(btrim(p_proposed_from), '');
  v_to_uid TEXT := NULLIF(btrim(p_proposed_to), '');
  v_raw_line GEOMETRY(LineString, 4326);
  v_voltage TEXT;
  v_from_geom GEOMETRY(Point, 4326);
  v_to_geom GEOMETRY(Point, 4326);
  v_line_geom GEOMETRY(LineString, 4326);
  v_snapped GEOMETRY(LineString, 4326);
  v_start_gap DOUBLE PRECISION;
  v_end_gap DOUBLE PRECISION;
  v_span_m DOUBLE PRECISION;
  v_start_move DOUBLE PRECISION;
  v_end_move DOUBLE PRECISION;
  v_snap_action TEXT;
BEGIN
  SELECT gis.as_linestring(cs.geom), cs.voltage_class
  INTO v_raw_line, v_voltage
  FROM gis.conductor_segments cs
  WHERE cs.id = p_segment_id;

  v_from_geom := gis.district_endpoint_geom(v_district, v_from_uid);
  v_to_geom := gis.district_endpoint_geom(v_district, v_to_uid);

  IF v_raw_line IS NULL OR v_from_geom IS NULL OR v_to_geom IS NULL THEN
    RETURN jsonb_build_object(
      'district_from_resolved', v_from_geom IS NOT NULL,
      'district_to_resolved', v_to_geom IS NOT NULL,
      'has_line_geom', v_raw_line IS NOT NULL,
      'start_gap_m', NULL,
      'end_gap_m', NULL,
      'max_gap_m', NULL,
      'snap_ready', FALSE,
      'topology_ready', FALSE,
      'snap_action', 'unresolved'
    );
  END IF;

  IF ST_Distance(ST_StartPoint(v_raw_line)::geography, v_from_geom::geography)
     + ST_Distance(ST_EndPoint(v_raw_line)::geography, v_to_geom::geography)
    <= ST_Distance(ST_StartPoint(v_raw_line)::geography, v_to_geom::geography)
     + ST_Distance(ST_EndPoint(v_raw_line)::geography, v_from_geom::geography)
  THEN
    v_line_geom := v_raw_line;
  ELSE
    v_line_geom := ST_Reverse(v_raw_line);
  END IF;

  v_start_gap := ST_Distance(ST_StartPoint(v_line_geom)::geography, v_from_geom::geography);
  v_end_gap := ST_Distance(ST_EndPoint(v_line_geom)::geography, v_to_geom::geography);
  v_span_m := ST_Distance(v_from_geom::geography, v_to_geom::geography);
  v_start_move := v_start_gap;
  v_end_move := v_end_gap;

  v_snapped := ST_SetPoint(
    ST_SetPoint(v_line_geom, 0, v_from_geom),
    ST_NPoints(v_line_geom) - 1,
    v_to_geom
  );

  IF v_span_m > gis.max_conductor_snap_span_m(v_voltage) THEN
    v_snap_action := 'span_rejected';
  ELSIF v_start_move <= p_topology_tolerance_m AND v_end_move <= p_topology_tolerance_m THEN
    v_snap_action := 'aligned';
  ELSIF v_start_move > p_max_snap_move_m OR v_end_move > p_max_snap_move_m THEN
    v_snap_action := 'move_rejected';
  ELSE
    v_snap_action := 'snap';
  END IF;

  RETURN jsonb_build_object(
    'district_from_resolved', TRUE,
    'district_to_resolved', TRUE,
    'has_line_geom', TRUE,
    'start_gap_m', round(v_start_gap::numeric, 2),
    'end_gap_m', round(v_end_gap::numeric, 2),
    'max_gap_m', round(GREATEST(v_start_gap, v_end_gap)::numeric, 2),
    'span_m', round(v_span_m::numeric, 2),
    'snap_ready', v_snap_action IN ('aligned', 'snap'),
    'topology_ready', v_snap_action IN ('aligned', 'snap'),
    'snap_action', v_snap_action,
    'topology_tolerance_m', p_topology_tolerance_m,
    'max_snap_move_m', p_max_snap_move_m,
    'snapped_line', ST_AsGeoJSON(v_snapped)::json
  );
END;
$$;

CREATE OR REPLACE FUNCTION gis.snap_conductor_segments_by_ids(
  p_segment_ids BIGINT[],
  p_tolerance_m DOUBLE PRECISION DEFAULT 1.0,
  p_max_move_m DOUBLE PRECISION DEFAULT 150.0
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = gis, public
AS $$
DECLARE
  v_snapped BIGINT := 0;
  v_aligned BIGINT := 0;
  v_rejected BIGINT := 0;
BEGIN
  IF p_segment_ids IS NULL OR cardinality(p_segment_ids) = 0 THEN
    RETURN jsonb_build_object('segments_snapped', 0, 'segments_already_aligned', 0, 'segments_rejected', 0);
  END IF;

  DROP TABLE IF EXISTS _snap_by_id;
  CREATE TEMP TABLE _snap_by_id ON COMMIT DROP AS
  WITH resolved AS (
    SELECT
      cs.id,
      cs.voltage_class,
      src.geom AS src_geom,
      tgt.geom AS tgt_geom,
      gis.as_linestring(cs.geom) AS raw_line,
      ST_Distance(src.geom::geography, tgt.geom::geography) AS span_m
    FROM gis.conductor_segments cs
    INNER JOIN LATERAL gis.resolve_endpoint(cs.district, cs.originating_node_id) src ON src.mrid IS NOT NULL
    INNER JOIN LATERAL gis.resolve_endpoint(cs.district, cs.end_node_id) tgt ON tgt.mrid IS NOT NULL
    WHERE cs.id = ANY(p_segment_ids)
      AND cs.originating_node_id IS NOT NULL
      AND cs.end_node_id IS NOT NULL
      AND btrim(cs.originating_node_id) <> ''
      AND btrim(cs.end_node_id) <> ''
      AND src.mrid IS DISTINCT FROM tgt.mrid
  ),
  oriented AS (
    SELECT
      r.*,
      CASE
        WHEN r.raw_line IS NULL THEN NULL
        WHEN ST_Distance(ST_StartPoint(r.raw_line)::geography, r.src_geom::geography)
           + ST_Distance(ST_EndPoint(r.raw_line)::geography, r.tgt_geom::geography)
          <= ST_Distance(ST_StartPoint(r.raw_line)::geography, r.tgt_geom::geography)
           + ST_Distance(ST_EndPoint(r.raw_line)::geography, r.src_geom::geography)
        THEN r.raw_line
        ELSE ST_Reverse(r.raw_line)
      END AS line_geom
    FROM resolved r
  ),
  measured AS (
    SELECT
      o.*,
      CASE WHEN o.line_geom IS NULL THEN NULL
        ELSE ST_Distance(ST_StartPoint(o.line_geom)::geography, o.src_geom::geography)
      END AS start_move_m,
      CASE WHEN o.line_geom IS NULL THEN NULL
        ELSE ST_Distance(ST_EndPoint(o.line_geom)::geography, o.tgt_geom::geography)
      END AS end_move_m
    FROM oriented o
  )
  SELECT
    m.id,
    CASE
      WHEN m.line_geom IS NULL THEN NULL
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
  FROM _snap_by_id c
  WHERE cs.id = c.id
    AND c.action = 'snap'
    AND c.snapped_geom IS NOT NULL;

  GET DIAGNOSTICS v_snapped = ROW_COUNT;

  SELECT
    COUNT(*) FILTER (WHERE action = 'aligned'),
    COUNT(*) FILTER (WHERE action IN ('span_rejected', 'move_rejected', 'no_geom'))
  INTO v_aligned, v_rejected
  FROM _snap_by_id;

  DROP TABLE IF EXISTS _snap_by_id;

  RETURN jsonb_build_object(
    'segments_snapped', v_snapped,
    'segments_already_aligned', v_aligned,
    'segments_rejected', v_rejected,
    'tolerance_m', p_tolerance_m,
    'max_move_m', p_max_move_m
  );
END;
$$;

CREATE OR REPLACE FUNCTION gis.apply_endpoint_fix_proposals(
  p_proposal_ids UUID[] DEFAULT NULL,
  p_district TEXT DEFAULT NULL,
  p_operator TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = gis, public
AS $$
DECLARE
  v_district TEXT := NULLIF(btrim(p_district), '');
  v_applied BIGINT := 0;
  v_segment_ids BIGINT[];
  v_snap JSONB;
BEGIN
  WITH to_apply AS (
    SELECT p.id, p.segment_id, p.proposed_from, p.proposed_to
    FROM gis.conductor_endpoint_proposals p
    WHERE p.status = 'approved'
      AND (p_proposal_ids IS NULL OR p.id = ANY(p_proposal_ids))
      AND (v_district IS NULL OR p.district = v_district)
  ),
  updated AS (
    UPDATE gis.conductor_segments cs
    SET
      originating_node_id = t.proposed_from,
      end_node_id = t.proposed_to
    FROM to_apply t
    WHERE cs.id = t.segment_id
    RETURNING cs.id
  ),
  marked AS (
    UPDATE gis.conductor_endpoint_proposals p
    SET
      status = 'applied',
      applied_at = now(),
      reviewed_by = COALESCE(p.reviewed_by, p_operator)
    FROM to_apply t
    WHERE p.id = t.id
    RETURNING p.id
  )
  SELECT
    (SELECT COUNT(*)::bigint FROM marked),
    (SELECT COALESCE(array_agg(DISTINCT id), ARRAY[]::bigint[]) FROM updated)
  INTO v_applied, v_segment_ids;

  IF v_applied > 0 AND cardinality(v_segment_ids) > 0 THEN
    v_snap := gis.snap_conductor_segments_by_ids(v_segment_ids, 1.0, 150.0);
    PERFORM gis.refresh_conductor_import_status();
  ELSE
    v_snap := jsonb_build_object('segments_snapped', 0, 'segments_already_aligned', 0, 'segments_rejected', 0);
  END IF;

  RETURN jsonb_build_object(
    'applied', v_applied,
    'operator', p_operator,
    'district', v_district,
    'geometry_snap', v_snap
  );
END;
$$;

GRANT EXECUTE ON FUNCTION gis.district_endpoint_geom(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gis.preview_endpoint_topology_alignment(BIGINT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION) TO service_role;
GRANT EXECUTE ON FUNCTION gis.snap_conductor_segments_by_ids(BIGINT[], DOUBLE PRECISION, DOUBLE PRECISION) TO service_role;
