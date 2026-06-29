-- Expose asset_kind on Martin connectivity-node tiles (transformer vs pole vs generic).
-- asset_kind must be appended after geom (CREATE OR REPLACE cannot reorder columns).
-- 00019 replaces per-row function with a lateral join for tile performance.

CREATE OR REPLACE VIEW public.map_connectivity_nodes AS
SELECT
  cn.mrid,
  cn.boundary_feeder_id,
  io.name,
  io.validation::text AS validation,
  cn.geom,
  public.asset_kind_for_mrid(cn.mrid) AS asset_kind
FROM public.connectivity_nodes cn
JOIN public.identified_objects io ON io.mrid = cn.mrid;

COMMENT ON VIEW public.map_connectivity_nodes IS
  'Martin map layer: connectivity nodes with validation, feeder, geom, and asset_kind for symbology.';

GRANT SELECT ON public.map_connectivity_nodes TO anon, authenticated, service_role;
