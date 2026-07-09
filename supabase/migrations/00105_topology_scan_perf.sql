-- Topology master scan performance: age-aware connected-node MV refresh.
--
-- Intentionally NO CREATE INDEX here. On ~1M-row tables, non-concurrent index
-- builds take 10+ minutes and block behind long DQ INSERTs (migration hangs).
-- Existing indexes already cover the hot paths:
--   idx_identified_objects_validation
--   idx_dq_exceptions_rule_status
--   idx_ac_line_segments_source_node / idx_ac_line_segments_target_node
--   idx_connectivity_nodes_orphan_scan

-- Track last successful connected-node MV refresh so scans can skip rebuild.
CREATE TABLE IF NOT EXISTS public.topology_scan_cache_meta (
  key TEXT PRIMARY KEY,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO public.topology_scan_cache_meta (key, refreshed_at, details)
VALUES (
  'connected_node_mrids',
  NOW() - INTERVAL '1 day',
  '{"note":"seed — force refresh on first scan after migration"}'::jsonb
)
ON CONFLICT (key) DO NOTHING;

GRANT SELECT, INSERT, UPDATE ON public.topology_scan_cache_meta TO service_role;
GRANT SELECT ON public.topology_scan_cache_meta TO authenticated;

-- Replace zero-arg refresh with age-aware version.
-- p_max_age_seconds=0 → always refresh (promote pipelines; DEFAULT keeps
--   refresh_connected_node_mrids() call sites working).
-- p_max_age_seconds>0 → skip if MV was refreshed within that window.
DROP FUNCTION IF EXISTS public.refresh_connected_node_mrids();

CREATE OR REPLACE FUNCTION public.refresh_connected_node_mrids(
  p_max_age_seconds INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n BIGINT;
  t0 TIMESTAMPTZ := clock_timestamp();
  last_at TIMESTAMPTZ;
  age_sec DOUBLE PRECISION;
BEGIN
  IF COALESCE(p_max_age_seconds, 0) > 0 THEN
    SELECT refreshed_at, COALESCE((details->>'connected_nodes')::bigint, -1)
      INTO last_at, n
    FROM public.topology_scan_cache_meta
    WHERE key = 'connected_node_mrids';

    IF last_at IS NOT NULL THEN
      age_sec := EXTRACT(EPOCH FROM (NOW() - last_at));
      IF age_sec < p_max_age_seconds THEN
        RETURN jsonb_build_object(
          'connected_nodes', n,
          'duration_ms', (EXTRACT(EPOCH FROM (clock_timestamp() - t0)) * 1000)::int,
          'skipped', TRUE,
          'age_seconds', age_sec::int,
          'max_age_seconds', p_max_age_seconds
        );
      END IF;
    END IF;
  END IF;

  -- Non-concurrent refresh is much faster; topology scans already serialize
  -- via app lock. Fall back to CONCURRENTLY if the MV is locked for reads.
  BEGIN
    REFRESH MATERIALIZED VIEW public.connected_node_mrids;
  EXCEPTION
    WHEN OTHERS THEN
      REFRESH MATERIALIZED VIEW CONCURRENTLY public.connected_node_mrids;
  END;

  SELECT COUNT(*) INTO n FROM public.connected_node_mrids;

  INSERT INTO public.topology_scan_cache_meta (key, refreshed_at, details)
  VALUES (
    'connected_node_mrids',
    NOW(),
    jsonb_build_object('connected_nodes', n)
  )
  ON CONFLICT (key) DO UPDATE
  SET refreshed_at = EXCLUDED.refreshed_at,
      details = EXCLUDED.details;

  RETURN jsonb_build_object(
    'connected_nodes', n,
    'duration_ms', (EXTRACT(EPOCH FROM (clock_timestamp() - t0)) * 1000)::int,
    'skipped', FALSE
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_connected_node_mrids(INTEGER) TO service_role;
