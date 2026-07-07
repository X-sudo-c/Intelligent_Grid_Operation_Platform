-- Map tiles: GIS conductor segments not yet promoted to master (gap layer for compare mode).

CREATE OR REPLACE VIEW public.map_unpromoted_conductor_segments AS
SELECT
  cs.id,
  cs.source_layer,
  gis.voltage_class_to_enum(cs.voltage_class)::text AS nominal_voltage,
  cs.district,
  CASE
    WHEN cs.source_layer LIKE 'ug\_%' ESCAPE '\' THEN 'UNDERGROUND'
    ELSE 'OVERHEAD'
  END AS installation_type,
  gis.as_linestring(cs.geom)::geometry(LineString, 4326) AS geom,
  ST_Length(gis.as_linestring(cs.geom)::geography) AS length_m
FROM gis.conductor_segments cs
WHERE cs.geom IS NOT NULL
  AND gis.as_linestring(cs.geom) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.ac_line_segments als
    WHERE als.mrid = gis.conductor_segment_mrid(cs.source_layer, cs.source_fid)
  )
  AND ST_Length(gis.as_linestring(cs.geom)::geography) <= 50000;

COMMENT ON VIEW public.map_unpromoted_conductor_segments IS
  'Martin map layer: GIS import lines with no ac_line_segments row (cyan gap layer in Both mode).';

GRANT SELECT ON public.map_unpromoted_conductor_segments TO anon, authenticated, service_role;
