-- Durable queue for master topology DQ batch scans (pgmq consumer in sync-service).

DO $pgmq$
BEGIN
  PERFORM pgmq.create('topology_dq_jobs');
EXCEPTION
  WHEN duplicate_object OR OTHERS THEN
    NULL;
END;
$pgmq$;

CREATE OR REPLACE FUNCTION public.enqueue_topology_dq_job(p_run_id UUID)
RETURNS BIGINT
LANGUAGE plpgsql
SET search_path = public, pgmq, extensions
AS $$
DECLARE
  v_msg_id BIGINT;
BEGIN
  SELECT pgmq.send(
    'topology_dq_jobs',
    jsonb_build_object('run_id', p_run_id::text)
  ) INTO v_msg_id;
  RETURN v_msg_id;
END;
$$;

COMMENT ON FUNCTION public.enqueue_topology_dq_job(UUID) IS
  'Enqueue a data_quality_batch_runs row for async topology scan worker.';

GRANT EXECUTE ON FUNCTION public.enqueue_topology_dq_job(UUID) TO service_role;
