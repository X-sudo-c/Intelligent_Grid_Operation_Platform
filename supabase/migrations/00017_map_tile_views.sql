-- Enriched map tile views for Martin (nominal_voltage + validation on vector tiles).

CREATE OR REPLACE VIEW public.map_connectivity_nodes AS
SELECT
  cn.mrid,
  cn.boundary_feeder_id,
  io.name,
  io.validation::text AS validation,
  cn.geom
FROM public.connectivity_nodes cn
JOIN public.identified_objects io ON io.mrid = cn.mrid;

CREATE OR REPLACE VIEW public.map_ac_line_segments AS
SELECT
  als.mrid,
  ce.nominal_voltage::text AS nominal_voltage,
  ce.phases,
  io.name,
  io.validation::text AS validation,
  als.geom
FROM public.ac_line_segments als
JOIN public.conducting_equipment ce ON ce.mrid = als.mrid
JOIN public.identified_objects io ON io.mrid = als.mrid;

COMMENT ON VIEW public.map_connectivity_nodes IS
  'Martin map layer: connectivity nodes with validation and feeder for MapLibre styling.';
COMMENT ON VIEW public.map_ac_line_segments IS
  'Martin map layer: line segments with nominal_voltage and validation for MapLibre styling.';

GRANT SELECT ON public.map_connectivity_nodes TO anon, authenticated, service_role;
GRANT SELECT ON public.map_ac_line_segments TO anon, authenticated, service_role;
