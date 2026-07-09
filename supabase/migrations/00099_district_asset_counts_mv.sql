-- Pre-aggregated master asset counts per ECG district for fast voice/copilot inventory queries.

CREATE MATERIALIZED VIEW IF NOT EXISTS gis.district_asset_counts_master AS
SELECT
  b.district,
  b.region,
  CASE am.source_layer
    WHEN 'distribution_transformer' THEN 'distribution_transformer'
    WHEN 'power_transformer' THEN 'power_transformer'
    WHEN 'oh_support_structure_11kv' THEN 'pole_11kv'
    WHEN 'oh_support_structure_33kv' THEN 'pole_33kv'
    WHEN 'oh_support_structure_lvle' THEN 'pole_lv'
    ELSE 'connectivity_node'
  END AS asset_kind,
  COUNT(*)::bigint AS asset_count
FROM public.connectivity_nodes cn
JOIN public.identified_objects io ON io.mrid = cn.mrid
LEFT JOIN (
  SELECT DISTINCT ON (mrid) mrid, source_layer
  FROM gis.asset_id_map
  ORDER BY mrid, source_fid
) am ON am.mrid = cn.mrid
JOIN gis.ecg_admin_boundaries b ON ST_Within(cn.geom, b.geom)
WHERE io.validation = 'APPROVED'
  AND cn.geom IS NOT NULL
  AND b.district IS NOT NULL
  AND TRIM(b.district) <> ''
GROUP BY
  b.district,
  b.region,
  CASE am.source_layer
    WHEN 'distribution_transformer' THEN 'distribution_transformer'
    WHEN 'power_transformer' THEN 'power_transformer'
    WHEN 'oh_support_structure_11kv' THEN 'pole_11kv'
    WHEN 'oh_support_structure_33kv' THEN 'pole_33kv'
    WHEN 'oh_support_structure_lvle' THEN 'pole_lv'
    ELSE 'connectivity_node'
  END
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_district_asset_counts_master_key
  ON gis.district_asset_counts_master (district, region, asset_kind);

CREATE INDEX IF NOT EXISTS idx_district_asset_counts_master_district
  ON gis.district_asset_counts_master (district);

CREATE INDEX IF NOT EXISTS idx_district_asset_counts_master_region
  ON gis.district_asset_counts_master (region);

COMMENT ON MATERIALIZED VIEW gis.district_asset_counts_master IS
  'Pre-aggregated master connectivity node counts by ECG district and asset kind; refresh after GIS promote.';

REFRESH MATERIALIZED VIEW gis.district_asset_counts_master;

CREATE OR REPLACE FUNCTION gis.refresh_district_asset_counts_master()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = gis, public
AS $$
DECLARE
  n BIGINT;
  t0 TIMESTAMPTZ := clock_timestamp();
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY gis.district_asset_counts_master;
  SELECT COALESCE(SUM(asset_count), 0)::bigint INTO n
  FROM gis.district_asset_counts_master;
  RETURN jsonb_build_object(
    'rows', (SELECT COUNT(*)::bigint FROM gis.district_asset_counts_master),
    'asset_total', n,
    'duration_ms', (EXTRACT(EPOCH FROM (clock_timestamp() - t0)) * 1000)::int
  );
END;
$$;

CREATE OR REPLACE FUNCTION gis.promote_topology_to_cim()
RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'unique_id_lookup', gis.rebuild_unique_id_lookup(),
    'support_structures', gis.promote_support_structures_to_cim(),
    'endpoint_infer_tier_a', gis.infer_conductor_endpoint_ids_tier_a(5.0::double precision, NULL::text),
    'conductor_snap', gis.snap_eligible_conductor_endpoints(),
    'conductors', gis.promote_conductors_to_cim(),
    'import_status', gis.refresh_conductor_import_status(),
    'connected_nodes', public.refresh_connected_node_mrids(),
    'map_unpromoted_gap', public.refresh_map_unpromoted_conductor_segments(FALSE),
    'district_asset_counts', gis.refresh_district_asset_counts_master()
  );
$$ LANGUAGE sql;

GRANT SELECT ON gis.district_asset_counts_master TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION gis.refresh_district_asset_counts_master() TO service_role;

ANALYZE gis.district_asset_counts_master;
