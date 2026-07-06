-- Map display: expose segment length and guard snap from creating cross-district chords.
-- length_m must be appended last (Postgres CREATE OR REPLACE VIEW cannot reorder columns).

DROP VIEW IF EXISTS public.map_ac_line_segments;

CREATE VIEW public.map_ac_line_segments AS
SELECT
  als.mrid,
  ce.nominal_voltage::text AS nominal_voltage,
  ce.phases,
  io.name,
  io.validation::text AS validation,
  als.geom,
  CASE
    WHEN io.name LIKE 'ug\_%' ESCAPE '\' THEN 'UNDERGROUND'
    WHEN io.name LIKE 'oh\_%' ESCAPE '\' THEN 'OVERHEAD'
    ELSE 'OVERHEAD'
  END AS installation_type,
  ST_Length(als.geom::geography) AS length_m
FROM public.ac_line_segments als
JOIN public.conducting_equipment ce ON ce.mrid = als.mrid
JOIN public.identified_objects io ON io.mrid = als.mrid
WHERE CASE ce.nominal_voltage::text
  WHEN 'LV_230V' THEN ST_Length(als.geom::geography) <= 1500
  WHEN 'LV_400V' THEN ST_Length(als.geom::geography) <= 1500
  WHEN 'MV_33KV' THEN ST_Length(als.geom::geography) <= 12000
  ELSE ST_Length(als.geom::geography) <= 6000
END;

COMMENT ON VIEW public.map_ac_line_segments IS
  'Martin map layer: promoted lines within plausible span limits (excludes bad snap chords).';

GRANT SELECT ON public.map_ac_line_segments TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION gis.max_conductor_snap_span_m(p_voltage_class TEXT)
RETURNS DOUBLE PRECISION AS $$
  SELECT CASE p_voltage_class
    WHEN 'MV_33KV' THEN 12000
    WHEN 'MV_11KV' THEN 6000
    WHEN 'LV' THEN 1500
    ELSE 6000
  END;
$$ LANGUAGE sql IMMUTABLE;

-- Endpoint-move snap: preserve the as-built line path, only relocate the two
-- endpoints onto their resolved nodes. Never replaces geometry with a chord.
-- The old implementation (00066) rebuilt geom = ST_MakeLine(src, tgt), which
-- destroyed interior vertices and drew cross-district chords when endpoint IDs
-- resolved to wrong/distant poles.

CREATE OR REPLACE FUNCTION gis.snap_eligible_conductor_endpoints(
  p_tolerance_m DOUBLE PRECISION DEFAULT 1.0,
  p_max_move_m DOUBLE PRECISION DEFAULT 150.0
)
RETURNS JSONB AS $$
DECLARE
  v_snapped BIGINT := 0;
  v_already_aligned BIGINT := 0;
  v_no_geom BIGINT := 0;
  v_unresolved BIGINT := 0;
  v_span_rejected BIGINT := 0;
  v_move_rejected BIGINT := 0;
BEGIN
  DROP TABLE IF EXISTS _snap_classified;
  CREATE TEMP TABLE _snap_classified ON COMMIT DROP AS
  WITH resolved AS (
    SELECT
      cs.id,
      cs.voltage_class,
      src.geom AS src_geom,
      tgt.geom AS tgt_geom,
      gis.as_linestring(cs.geom) AS raw_line,
      ST_Distance(src.geom::geography, tgt.geom::geography) AS span_m
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
  oriented AS (
    SELECT
      r.*,
      -- The as-built line may be digitized tgt→src; pick the orientation whose
      -- endpoints sit closest to the resolved nodes before measuring moves.
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
      -- Endpoint resolved to a node far from the as-built end: the ID mapping is
      -- suspect — keep the original geometry rather than dragging a chord.
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

  DROP TABLE IF EXISTS _snap_classified;

  RETURN jsonb_build_object(
    'segments_snapped', v_snapped,
    'segments_already_aligned', v_already_aligned,
    'segments_no_geom', v_no_geom,
    'segments_unresolved', v_unresolved,
    'segments_span_rejected', v_span_rejected,
    'segments_move_rejected', v_move_rejected,
    'tolerance_m', p_tolerance_m,
    'max_move_m', p_max_move_m
  );
END;
$$ LANGUAGE plpgsql;

-- The 00066 signature (single arg) is superseded; drop it so callers bind the new one.
DROP FUNCTION IF EXISTS gis.snap_eligible_conductor_endpoints(DOUBLE PRECISION);

COMMENT ON FUNCTION gis.snap_eligible_conductor_endpoints(DOUBLE PRECISION, DOUBLE PRECISION) IS
  'Endpoint-move snap: relocates line endpoints onto resolved nodes, preserving the as-built path. Rejects moves beyond p_max_move_m.';

GRANT EXECUTE ON FUNCTION gis.max_conductor_snap_span_m(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gis.snap_eligible_conductor_endpoints(DOUBLE PRECISION, DOUBLE PRECISION) TO service_role;
