-- District-scale endpoint fix AI scan runs + durable pgmq queue.

CREATE TABLE IF NOT EXISTS gis.endpoint_fix_ai_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  district TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  reasoning_depth TEXT NOT NULL DEFAULT 'quick'
    CHECK (reasoning_depth IN ('quick', 'deep')),
  batch_size INTEGER NOT NULL DEFAULT 50
    CHECK (batch_size >= 1 AND batch_size <= 100),
  total_pending INTEGER NOT NULL DEFAULT 0,
  rows_reviewed INTEGER NOT NULL DEFAULT 0,
  batches_completed INTEGER NOT NULL DEFAULT 0,
  last_model TEXT,
  error_message TEXT,
  requested_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_endpoint_fix_ai_runs_district_status
  ON gis.endpoint_fix_ai_runs (district, status, created_at DESC);

DO $pgmq$
BEGIN
  PERFORM pgmq.create('endpoint_fix_ai_jobs');
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%already exists%' THEN
      RAISE;
    END IF;
END;
$pgmq$;

CREATE OR REPLACE FUNCTION public.enqueue_endpoint_fix_ai_job(p_run_id UUID)
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pgmq, extensions
AS $$
  SELECT pgmq.send(
    'endpoint_fix_ai_jobs',
    jsonb_build_object('run_id', p_run_id::text)
  );
$$;

GRANT SELECT, INSERT, UPDATE ON gis.endpoint_fix_ai_runs TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_endpoint_fix_ai_job(UUID) TO service_role;
