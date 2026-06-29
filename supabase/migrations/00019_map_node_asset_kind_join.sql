-- Faster asset_kind on map_connectivity_nodes (join vs per-row function).

CREATE OR REPLACE VIEW public.map_connectivity_nodes AS
SELECT
  cn.mrid,
  cn.boundary_feeder_id,
  io.name,
  io.validation::text AS validation,
  cn.geom,
  CASE am.source_layer
    WHEN 'distribution_transformer' THEN 'distribution_transformer'
    WHEN 'power_transformer' THEN 'power_transformer'
    WHEN 'oh_support_structure_11kv' THEN 'pole_11kv'
    WHEN 'oh_support_structure_33kv' THEN 'pole_33kv'
    WHEN 'oh_support_structure_lvle' THEN 'pole_lv'
    ELSE 'connectivity_node'
  END AS asset_kind
FROM public.connectivity_nodes cn
JOIN public.identified_objects io ON io.mrid = cn.mrid
LEFT JOIN LATERAL (
  SELECT source_layer
  FROM gis.asset_id_map
  WHERE mrid = cn.mrid
  ORDER BY source_fid
  LIMIT 1
) am ON TRUE;

COMMENT ON VIEW public.map_connectivity_nodes IS
  'Martin map layer: connectivity nodes with validation, feeder, geom, and asset_kind for symbology.';

GRANT SELECT ON public.map_connectivity_nodes TO anon, authenticated, service_role;
