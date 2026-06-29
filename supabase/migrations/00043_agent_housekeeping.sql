-- Agent engine housekeeping: pg_cron retention for audit/validation artifacts.

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      PERFORM cron.unschedule('agent_audit_log_cleanup');
    EXCEPTION
      WHEN OTHERS THEN NULL;
    END;
    BEGIN
      PERFORM cron.unschedule('validation_results_cleanup');
    EXCEPTION
      WHEN OTHERS THEN NULL;
    END;

    PERFORM cron.schedule(
      'agent_audit_log_cleanup',
      '15 3 * * *',
      $job$
        DELETE FROM public.agent_audit_log
        WHERE created_at < NOW() - INTERVAL '90 days';
      $job$
    );

    PERFORM cron.schedule(
      'validation_results_cleanup',
      '30 3 * * *',
      $job$
        DELETE FROM public.validation_results
        WHERE created_at < NOW() - INTERVAL '90 days';
      $job$
    );
  END IF;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'pg_cron agent housekeeping skipped — tables not ready';
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron agent housekeeping skipped: %', SQLERRM;
END;
$cron$;

COMMENT ON TABLE public.agent_audit_log IS
  'Multi-agent audit trail. Retained 90 days via pg_cron job agent_audit_log_cleanup. '
  'Nightly validation cycles: run `python -m agents.scheduler` from sync-service (system cron).';
