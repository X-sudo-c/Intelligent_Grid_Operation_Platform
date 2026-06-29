-- FR-020 perf: persist the full topology DQ summary as a snapshot per batch run.
-- Lets the portal serve the topology panel from the last scan (a single indexed
-- row read) instead of recomputing the national orphan/dangling scan on load.

ALTER TABLE public.data_quality_batch_runs
  ADD COLUMN IF NOT EXISTS summary_snapshot JSONB;

COMMENT ON COLUMN public.data_quality_batch_runs.summary_snapshot IS
  'Full {live, exception_queue, export_blocked} summary captured when the scan completed.';

-- Fast "latest completed topology snapshot" lookup.
CREATE INDEX IF NOT EXISTS idx_dq_batch_runs_latest_topology
  ON public.data_quality_batch_runs (completed_at DESC)
  WHERE status = 'completed' AND scan_type = 'topology_master';
