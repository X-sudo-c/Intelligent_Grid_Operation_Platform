-- Revert map_connectivity_nodes to a lightweight view (Martin hangs on 924k-row joined view).
-- Transformer map icons use gis.distribution_transformer + gis.power_transformer sources instead.

DROP MATERIALIZED VIEW IF EXISTS public.map_connectivity_nodes;
DROP VIEW IF EXISTS public.map_connectivity_nodes;

CREATE OR REPLACE VIEW public.map_connectivity_nodes AS
SELECT
  cn.mrid,
  cn.boundary_feeder_id,
  io.name,
  io.validation::text AS validation,
  cn.geom
FROM public.connectivity_nodes cn
JOIN public.identified_objects io ON io.mrid = cn.mrid;

COMMENT ON VIEW public.map_connectivity_nodes IS
  'Martin map layer: connectivity nodes (lightweight view for tile server startup).';

GRANT SELECT ON public.map_connectivity_nodes TO anon, authenticated, service_role;
