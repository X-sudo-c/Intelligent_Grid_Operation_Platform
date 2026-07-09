-- Fast Martin tiles: precompute map layers so every z/x/y does not join CIM tables
-- or evaluate ST_Length(geography) on ~1M lines.

-- ---------------------------------------------------------------------------
-- Connectivity nodes (~924k) — lightweight attributes only
-- ---------------------------------------------------------------------------

DO $drop_nodes$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'map_connectivity_nodes' AND c.relkind = 'm'
  ) THEN
    EXECUTE 'DROP MATERIALIZED VIEW public.map_connectivity_nodes';
  ELSIF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'map_connectivity_nodes' AND c.relkind = 'v'
  ) THEN
    EXECUTE 'DROP VIEW public.map_connectivity_nodes';
  END IF;
END
$drop_nodes$;

CREATE MATERIALIZED VIEW public.map_connectivity_nodes AS
SELECT
  cn.mrid,
  cn.boundary_feeder_id,
  io.name,
  io.validation::text AS validation,
  cn.geom
FROM public.connectivity_nodes cn
JOIN public.identified_objects io ON io.mrid = cn.mrid
WHERE cn.geom IS NOT NULL
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_map_connectivity_nodes_mrid
  ON public.map_connectivity_nodes (mrid);

CREATE INDEX IF NOT EXISTS idx_map_connectivity_nodes_geom
  ON public.map_connectivity_nodes USING GIST (geom);

COMMENT ON MATERIALIZED VIEW public.map_connectivity_nodes IS
  'Martin map layer: prejoined nodes for fast MVT (refresh after promote).';

REFRESH MATERIALIZED VIEW public.map_connectivity_nodes;

-- ---------------------------------------------------------------------------
-- AC line segments — precomputed length_m + installation_type (no live ST_Length)
-- ---------------------------------------------------------------------------

DO $drop_lines$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'map_ac_line_segments' AND c.relkind = 'm'
  ) THEN
    EXECUTE 'DROP MATERIALIZED VIEW public.map_ac_line_segments';
  ELSIF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'map_ac_line_segments' AND c.relkind = 'v'
  ) THEN
    EXECUTE 'DROP VIEW public.map_ac_line_segments';
  END IF;
END
$drop_lines$;

CREATE MATERIALIZED VIEW public.map_ac_line_segments AS
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
  ST_Length(als.geom::geography)::float4 AS length_m
FROM public.ac_line_segments als
JOIN public.conducting_equipment ce ON ce.mrid = als.mrid
JOIN public.identified_objects io ON io.mrid = als.mrid
WHERE als.geom IS NOT NULL
  AND ST_Length(als.geom::geography) <= gis.max_conductor_snap_span_m(
    CASE ce.nominal_voltage::text
      WHEN 'LV_230V' THEN 'LV'
      WHEN 'LV_400V' THEN 'LV'
      WHEN 'MV_33KV' THEN 'MV_33KV'
      WHEN 'MV_11KV' THEN 'MV_11KV'
      ELSE 'OTHER'
    END
  )
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_map_ac_line_segments_mrid
  ON public.map_ac_line_segments (mrid);

CREATE INDEX IF NOT EXISTS idx_map_ac_line_segments_geom
  ON public.map_ac_line_segments USING GIST (geom);

COMMENT ON MATERIALIZED VIEW public.map_ac_line_segments IS
  'Martin map layer: prejoined lines with length_m (no live geography ST_Length on tile path).';

REFRESH MATERIALIZED VIEW public.map_ac_line_segments;

-- ---------------------------------------------------------------------------
-- Power transformers (small; still benefit from MV + indexes)
-- ---------------------------------------------------------------------------

DO $drop_pt$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'map_power_transformers' AND c.relkind = 'm'
  ) THEN
    EXECUTE 'DROP MATERIALIZED VIEW public.map_power_transformers';
  ELSIF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'map_power_transformers' AND c.relkind = 'v'
  ) THEN
    EXECUTE 'DROP VIEW public.map_power_transformers';
  END IF;
END
$drop_pt$;

CREATE MATERIALIZED VIEW public.map_power_transformers AS
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
JOIN public.identified_objects io ON io.mrid = cn.mrid
WHERE cn.geom IS NOT NULL
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_map_power_transformers_mrid
  ON public.map_power_transformers (mrid);

CREATE INDEX IF NOT EXISTS idx_map_power_transformers_geom
  ON public.map_power_transformers USING GIST (geom);

COMMENT ON MATERIALIZED VIEW public.map_power_transformers IS
  'Martin map layer: prejoined DT/PT symbols at node geometry.';

REFRESH MATERIALIZED VIEW public.map_power_transformers;

GRANT SELECT ON public.map_connectivity_nodes TO anon, authenticated, service_role;
GRANT SELECT ON public.map_ac_line_segments TO anon, authenticated, service_role;
GRANT SELECT ON public.map_power_transformers TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Refresh helpers (CONCURRENTLY after first populate)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.refresh_map_tile_layers(concurrent boolean DEFAULT TRUE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, gis
AS $$
DECLARE
  t0 TIMESTAMPTZ := clock_timestamp();
  n_nodes BIGINT;
  n_lines BIGINT;
  n_pt BIGINT;
BEGIN
  IF concurrent THEN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.map_connectivity_nodes;
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.map_ac_line_segments;
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.map_power_transformers;
  ELSE
    REFRESH MATERIALIZED VIEW public.map_connectivity_nodes;
    REFRESH MATERIALIZED VIEW public.map_ac_line_segments;
    REFRESH MATERIALIZED VIEW public.map_power_transformers;
  END IF;

  SELECT COUNT(*) INTO n_nodes FROM public.map_connectivity_nodes;
  SELECT COUNT(*) INTO n_lines FROM public.map_ac_line_segments;
  SELECT COUNT(*) INTO n_pt FROM public.map_power_transformers;

  ANALYZE public.map_connectivity_nodes;
  ANALYZE public.map_ac_line_segments;
  ANALYZE public.map_power_transformers;

  RETURN jsonb_build_object(
    'nodes', n_nodes,
    'lines', n_lines,
    'power_transformers', n_pt,
    'concurrent', concurrent,
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
    'district_asset_counts', gis.refresh_district_asset_counts_master(),
    'map_tile_layers', public.refresh_map_tile_layers(TRUE)
  );
$$ LANGUAGE sql;

GRANT EXECUTE ON FUNCTION public.refresh_map_tile_layers(boolean) TO service_role;

ANALYZE public.map_connectivity_nodes;
ANALYZE public.map_ac_line_segments;
ANALYZE public.map_power_transformers;
