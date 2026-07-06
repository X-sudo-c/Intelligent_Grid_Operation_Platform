-- Restore full promoted line set on the map now that geometry is fixed.
-- length_m is kept for diagnostics; span filtering moved to snap-on-import only.

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
JOIN public.identified_objects io ON io.mrid = als.mrid;

COMMENT ON VIEW public.map_ac_line_segments IS
  'Martin map layer: all promoted line segments with length_m for styling/diagnostics.';

GRANT SELECT ON public.map_ac_line_segments TO anon, authenticated, service_role;
