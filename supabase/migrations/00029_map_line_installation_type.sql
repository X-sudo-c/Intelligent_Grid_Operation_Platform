-- Expose overhead vs underground on Martin detail line tiles (from GIS promote names).

CREATE OR REPLACE VIEW public.map_ac_line_segments AS
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
  END AS installation_type
FROM public.ac_line_segments als
JOIN public.conducting_equipment ce ON ce.mrid = als.mrid
JOIN public.identified_objects io ON io.mrid = als.mrid;

COMMENT ON VIEW public.map_ac_line_segments IS
  'Martin map layer: line segments with voltage, validation, and overhead/underground install type.';
