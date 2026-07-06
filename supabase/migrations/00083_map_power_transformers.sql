-- Martin tile view: promoted CIM PowerTransformer equipment at connectivity node locations.
-- Separate from map_connectivity_nodes so the 924k-node view stays lightweight.

CREATE OR REPLACE VIEW public.map_power_transformers AS
SELECT
  pt.mrid,
  pt.connectivity_node_mrid,
  pt.transformer_kind,
  pt.rated_power_kva,
  cn.boundary_feeder_id,
  io.name,
  io.validation::text AS validation,
  cn.geom
FROM public.power_transformers pt
JOIN public.connectivity_nodes cn ON cn.mrid = pt.connectivity_node_mrid
JOIN public.identified_objects io ON io.mrid = cn.mrid;

COMMENT ON VIEW public.map_power_transformers IS
  'Martin map layer: promoted master PowerTransformer symbols (DT/PT) at node geometry.';

GRANT SELECT ON public.map_power_transformers TO anon, authenticated, service_role;
