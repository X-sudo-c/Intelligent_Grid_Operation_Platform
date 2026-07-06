-- Performance advisor fixes: FK-supporting indexes, drop redundant indexes,
-- reclaim bloated DQ index pages, fail long-stuck topology scans.

-- ── Fail zombie topology scans blocking single-flight guard ───────────────
UPDATE public.data_quality_batch_runs
SET status = 'failed',
    error_message = COALESCE(
      error_message,
      'Scan interrupted (worker stopped). Clear lock and re-run after migration 00075.'
    ),
    completed_at = NOW()
WHERE scan_type = 'topology_master'
  AND status = 'running'
  AND started_at < NOW() - INTERVAL '15 minutes';

-- ── data_quality_exceptions: FK + scan/queue hot paths ────────────────────
CREATE INDEX IF NOT EXISTS idx_dq_exceptions_rule_status
  ON public.data_quality_exceptions (rule_code, status)
  WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS idx_dq_exceptions_cleanup_action
  ON public.data_quality_exceptions (cleanup_action_id)
  WHERE cleanup_action_id IS NOT NULL;

-- ── Topology / validation / repair workflow FK indexes ────────────────────
CREATE INDEX IF NOT EXISTS idx_topology_proposals_exception
  ON public.topology_change_proposals (exception_id)
  WHERE exception_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_validation_runs_topology_run
  ON public.validation_runs (topology_run_id)
  WHERE topology_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_validation_results_rule_code
  ON public.validation_results (rule_code)
  WHERE rule_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cleanup_actions_exception
  ON public.cleanup_actions (exception_id)
  WHERE exception_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cleanup_actions_run
  ON public.cleanup_actions (run_id)
  WHERE run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_approval_requests_exception
  ON public.approval_requests (exception_id)
  WHERE exception_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_approval_requests_cleanup
  ON public.approval_requests (cleanup_id)
  WHERE cleanup_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dq_batch_runs_running
  ON public.data_quality_batch_runs (started_at DESC)
  WHERE status = 'running' AND scan_type = 'topology_master';

-- ── Staging DQ (same FK pattern for when staging is active) ───────────────
CREATE INDEX IF NOT EXISTS idx_staging_dq_exceptions_rule_status
  ON staging.data_quality_exceptions (rule_code, status)
  WHERE status = 'OPEN';

-- ── Drop redundant / superseded indexes ───────────────────────────────────
DROP INDEX IF EXISTS gis.idx_place_aliases_trgm;
DROP INDEX IF EXISTS gis.idx_place_aliases_active;
DROP INDEX IF EXISTS gis.idx_gis_conductor_import_status_district_reason;

-- ── Reclaim bloat from aborted 675k-row orphan INSERT attempt ─────────────
REINDEX INDEX public.idx_dq_exceptions_record;
REINDEX INDEX public.idx_dq_exceptions_open_unique;
REINDEX INDEX public.idx_dq_exceptions_status;
REINDEX INDEX public.idx_dq_exceptions_queue;
REINDEX TABLE public.data_quality_exceptions;

-- ── Refresh planner stats on scan-heavy tables ────────────────────────────
ANALYZE public.data_quality_exceptions;
ANALYZE public.data_quality_batch_runs;
ANALYZE public.ac_line_segments;
ANALYZE public.connectivity_nodes;
ANALYZE gis.conductor_import_status;
ANALYZE gis.conductor_segments;
ANALYZE gis.asset_id_map;
