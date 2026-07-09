-- Map tile MV refresh performance: age-aware skip + faster non-concurrent refresh.
-- Does NOT change Martin minzoom/maxzoom or portal zoom settings.

-- Reuse topology_scan_cache_meta (00105) for map tile layer freshness.
INSERT INTO public.topology_scan_cache_meta (key, refreshed_at, details)
VALUES (
  'map_tile_layers',
  NOW() - INTERVAL '1 day',
  '{"note":"seed — force refresh on first call after migration"}'::jsonb
)
ON CONFLICT (key) DO NOTHING;

-- Replace boolean-only refresh with age-aware version.
-- p_max_age_seconds=0 → always refresh (promote pipelines; DEFAULT keeps
--   refresh_map_tile_layers() call sites working).
-- p_max_age_seconds>0 → skip if MVs were refreshed within that window.
DROP FUNCTION IF EXISTS public.refresh_map_tile_layers(boolean);

CREATE OR REPLACE FUNCTION public.refresh_map_tile_layers(
  p_max_age_seconds INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, gis
AS $$
DECLARE
  t0 TIMESTAMPTZ := clock_timestamp();
  last_at TIMESTAMPTZ;
  age_sec DOUBLE PRECISION;
  n_nodes BIGINT;
  n_lines BIGINT;
  n_pt BIGINT;
  details_cached JSONB;
BEGIN
  IF COALESCE(p_max_age_seconds, 0) > 0 THEN
    SELECT refreshed_at, details
      INTO last_at, details_cached
    FROM public.topology_scan_cache_meta
    WHERE key = 'map_tile_layers';

    IF last_at IS NOT NULL THEN
      age_sec := EXTRACT(EPOCH FROM (NOW() - last_at));
      IF age_sec < p_max_age_seconds THEN
        RETURN jsonb_build_object(
          'nodes', COALESCE((details_cached->>'nodes')::bigint, -1),
          'lines', COALESCE((details_cached->>'lines')::bigint, -1),
          'power_transformers', COALESCE((details_cached->>'power_transformers')::bigint, -1),
          'skipped', TRUE,
          'age_seconds', age_sec::int,
          'max_age_seconds', p_max_age_seconds,
          'duration_ms', (EXTRACT(EPOCH FROM (clock_timestamp() - t0)) * 1000)::int
        );
      END IF;
    END IF;
  END IF;

  -- Non-concurrent refresh is much faster; fall back to CONCURRENTLY if locked.
  BEGIN
    REFRESH MATERIALIZED VIEW public.map_connectivity_nodes;
    REFRESH MATERIALIZED VIEW public.map_ac_line_segments;
    REFRESH MATERIALIZED VIEW public.map_power_transformers;
  EXCEPTION
    WHEN OTHERS THEN
      REFRESH MATERIALIZED VIEW CONCURRENTLY public.map_connectivity_nodes;
      REFRESH MATERIALIZED VIEW CONCURRENTLY public.map_ac_line_segments;
      REFRESH MATERIALIZED VIEW CONCURRENTLY public.map_power_transformers;
  END;

  SELECT COUNT(*) INTO n_nodes FROM public.map_connectivity_nodes;
  SELECT COUNT(*) INTO n_lines FROM public.map_ac_line_segments;
  SELECT COUNT(*) INTO n_pt FROM public.map_power_transformers;

  ANALYZE public.map_connectivity_nodes;
  ANALYZE public.map_ac_line_segments;
  ANALYZE public.map_power_transformers;

  INSERT INTO public.topology_scan_cache_meta (key, refreshed_at, details)
  VALUES (
    'map_tile_layers',
    NOW(),
    jsonb_build_object(
      'nodes', n_nodes,
      'lines', n_lines,
      'power_transformers', n_pt
    )
  )
  ON CONFLICT (key) DO UPDATE
  SET refreshed_at = EXCLUDED.refreshed_at,
      details = EXCLUDED.details;

  RETURN jsonb_build_object(
    'nodes', n_nodes,
    'lines', n_lines,
    'power_transformers', n_pt,
    'skipped', FALSE,
    'duration_ms', (EXTRACT(EPOCH FROM (clock_timestamp() - t0)) * 1000)::int
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_map_tile_layers(INTEGER) TO service_role;

-- Backward-compat: old call sites passed a boolean "concurrent" flag.
-- TRUE/FALSE both mean "force refresh now" (do not cast TRUE→1s age skip).
CREATE OR REPLACE FUNCTION public.refresh_map_tile_layers(concurrent boolean)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, gis
AS $$
  SELECT public.refresh_map_tile_layers(0);
$$;

GRANT EXECUTE ON FUNCTION public.refresh_map_tile_layers(boolean) TO service_role;

-- Promote always forces a rebuild (integer 0).
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
    'map_tile_layers', public.refresh_map_tile_layers(0)
  );
$$ LANGUAGE sql;
