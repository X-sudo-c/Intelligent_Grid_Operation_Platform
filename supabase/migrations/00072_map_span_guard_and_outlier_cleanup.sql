-- Re-hide implausible span outliers on the map (legacy chord-snap artifacts).
-- Snap-on-import (00068) prevents new chords; master rows inserted before that fix
-- were never refreshed because promote_conductors_to_cim used ON CONFLICT DO NOTHING.

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
WHERE ST_Length(als.geom::geography) <= gis.max_conductor_snap_span_m(
  CASE ce.nominal_voltage::text
    WHEN 'LV_230V' THEN 'LV'
    WHEN 'LV_400V' THEN 'LV'
    WHEN 'MV_33KV' THEN 'MV_33KV'
    WHEN 'MV_11KV' THEN 'MV_11KV'
    ELSE 'OTHER'
  END
);

COMMENT ON VIEW public.map_ac_line_segments IS
  'Martin map layer: promoted lines within plausible span limits (excludes legacy snap chords).';

GRANT SELECT ON public.map_ac_line_segments TO anon, authenticated, service_role;

-- Drop legacy chord segments from master (typically <25 rows nationwide).
DELETE FROM public.ac_line_segments als
USING public.conducting_equipment ce
WHERE ce.mrid = als.mrid
  AND ST_Length(als.geom::geography) > gis.max_conductor_snap_span_m(
    CASE ce.nominal_voltage::text
      WHEN 'LV_230V' THEN 'LV'
      WHEN 'LV_400V' THEN 'LV'
      WHEN 'MV_33KV' THEN 'MV_33KV'
      WHEN 'MV_11KV' THEN 'MV_11KV'
      ELSE 'OTHER'
    END
  );

-- Reject implausible endpoint spans at promote time; refresh geometry on re-promote.
CREATE OR REPLACE FUNCTION gis.promote_conductors_to_cim()
RETURNS JSONB AS $$
DECLARE
  v_lines BIGINT;
  v_skipped BIGINT;
  v_unresolved BIGINT;
BEGIN
  DROP TABLE IF EXISTS _gis_eligible_conductors;
  ALTER TABLE public.ac_line_segments DISABLE TRIGGER trg_webhook_ac_line_segments;

  CREATE TEMP TABLE _gis_eligible_conductors ON COMMIT DROP AS
  SELECT
    cs.id,
    cs.source_layer,
    cs.source_fid,
    cs.voltage_class,
    cs.circuit_id,
    gis.conductor_segment_mrid(cs.source_layer, cs.source_fid) AS line_mrid,
    src.mrid AS source_mrid,
    tgt.mrid AS target_mrid,
    gis.as_linestring(cs.geom) AS line_geom
  FROM gis.conductor_segments cs
  JOIN gis.unique_id_lookup src
    ON src.unique_id = btrim(cs.originating_node_id)
  JOIN gis.unique_id_lookup tgt
    ON tgt.unique_id = btrim(cs.end_node_id)
  WHERE cs.originating_node_id IS NOT NULL
    AND cs.end_node_id IS NOT NULL
    AND btrim(cs.originating_node_id) <> ''
    AND btrim(cs.end_node_id) <> ''
    AND src.mrid IS DISTINCT FROM tgt.mrid
    AND gis.as_linestring(cs.geom) IS NOT NULL
    AND ST_Distance(src.geom::geography, tgt.geom::geography)
        <= gis.max_conductor_snap_span_m(cs.voltage_class)
    AND ST_Length(gis.as_linestring(cs.geom)::geography)
        <= gis.max_conductor_snap_span_m(cs.voltage_class);

  INSERT INTO public.identified_objects (mrid, name, lifecycle_state, validation)
  SELECT
    e.line_mrid,
    e.source_layer || ' segment ' || e.source_fid::text,
    'IN_SERVICE',
    'APPROVED'
  FROM _gis_eligible_conductors e
  ON CONFLICT (mrid) DO NOTHING;

  INSERT INTO public.conducting_equipment (mrid, phases, nominal_voltage, serial_number)
  SELECT
    e.line_mrid,
    'ABC',
    gis.voltage_class_to_enum(e.voltage_class),
    NULLIF(btrim(e.circuit_id), '')
  FROM _gis_eligible_conductors e
  ON CONFLICT (mrid) DO NOTHING;

  INSERT INTO public.ac_line_segments (
    mrid, source_node_id, target_node_id, direction_downstream, geom
  )
  SELECT
    e.line_mrid,
    e.source_mrid,
    e.target_mrid,
    TRUE,
    e.line_geom::geometry(LineString, 4326)
  FROM _gis_eligible_conductors e
  WHERE GeometryType(e.line_geom) = 'LINESTRING'
  ON CONFLICT (mrid) DO UPDATE SET
    source_node_id = EXCLUDED.source_node_id,
    target_node_id = EXCLUDED.target_node_id,
    geom = EXCLUDED.geom;

  GET DIAGNOSTICS v_lines = ROW_COUNT;

  ALTER TABLE public.ac_line_segments ENABLE TRIGGER trg_webhook_ac_line_segments;

  SELECT COUNT(*) INTO v_skipped
  FROM gis.conductor_segments cs
  WHERE cs.originating_node_id IS NULL
     OR cs.end_node_id IS NULL
     OR btrim(cs.originating_node_id) = ''
     OR btrim(cs.end_node_id) = '';

  SELECT COUNT(*) INTO v_unresolved
  FROM gis.conductor_segments cs
  WHERE cs.originating_node_id IS NOT NULL
    AND cs.end_node_id IS NOT NULL
    AND btrim(cs.originating_node_id) <> ''
    AND btrim(cs.end_node_id) <> ''
    AND NOT EXISTS (
      SELECT 1
      FROM _gis_eligible_conductors e
      WHERE e.id = cs.id
    );

  RETURN jsonb_build_object(
    'ac_line_segments_inserted', v_lines,
    'segments_missing_endpoints', v_skipped,
    'segments_unresolved_endpoints', v_unresolved
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION gis.promote_conductors_to_cim() IS
  'Promote resolvable GIS conductors; rejects implausible endpoint spans and refreshes geometry on re-promote.';
