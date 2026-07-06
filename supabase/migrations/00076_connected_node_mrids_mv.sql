-- Cached set of master node MRIDs referenced by ac_line_segments endpoints.
-- Speeds orphan detection (anti-join) on ~900k+ nodes / ~1M+ lines.

CREATE MATERIALIZED VIEW IF NOT EXISTS public.connected_node_mrids AS
SELECT source_node_id AS mrid
FROM public.ac_line_segments
WHERE source_node_id IS NOT NULL
UNION
SELECT target_node_id AS mrid
FROM public.ac_line_segments
WHERE target_node_id IS NOT NULL
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_connected_node_mrids_mrid
  ON public.connected_node_mrids (mrid);

-- First populate (CONCURRENTLY requires at least one populated refresh + unique index).
REFRESH MATERIALIZED VIEW public.connected_node_mrids;

CREATE OR REPLACE FUNCTION public.refresh_connected_node_mrids()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n BIGINT;
  t0 TIMESTAMPTZ := clock_timestamp();
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.connected_node_mrids;
  SELECT COUNT(*) INTO n FROM public.connected_node_mrids;
  RETURN jsonb_build_object(
    'connected_nodes', n,
    'duration_ms', (EXTRACT(EPOCH FROM (clock_timestamp() - t0)) * 1000)::int
  );
END;
$$;

-- Keep connected-node cache in sync after bulk GIS promote.
CREATE OR REPLACE FUNCTION gis.promote_topology_to_cim()
RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'unique_id_lookup', gis.rebuild_unique_id_lookup(),
    'support_structures', gis.promote_support_structures_to_cim(),
    'conductor_snap', gis.snap_eligible_conductor_endpoints(),
    'conductors', gis.promote_conductors_to_cim(),
    'import_status', gis.refresh_conductor_import_status(),
    'connected_nodes', public.refresh_connected_node_mrids()
  );
$$ LANGUAGE sql;

GRANT SELECT ON public.connected_node_mrids TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.refresh_connected_node_mrids() TO service_role;

ANALYZE public.connected_node_mrids;
