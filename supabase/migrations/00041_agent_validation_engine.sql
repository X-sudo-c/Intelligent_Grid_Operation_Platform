-- Multi-agent validation engine: runs, cleanup, approvals, audit, KPIs.

DO $types$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'validation_run_status') THEN
    CREATE TYPE public.validation_run_status AS ENUM (
      'pending', 'running', 'completed', 'failed', 'cancelled'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'validation_run_type') THEN
    CREATE TYPE public.validation_run_type AS ENUM (
      'full_cycle', 'asset_checks', 'topology_master', 'revalidation'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cleanup_mode') THEN
    CREATE TYPE public.cleanup_mode AS ENUM ('AUTO_FIX', 'ASSISTED', 'MANUAL');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cleanup_status') THEN
    CREATE TYPE public.cleanup_status AS ENUM (
      'proposed', 'pending_approval', 'approved', 'executed', 'failed', 'rejected', 'rolled_back'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'approval_status') THEN
    CREATE TYPE public.approval_status AS ENUM ('pending', 'approved', 'rejected', 'expired');
  END IF;
END;
$types$;

CREATE TABLE IF NOT EXISTS public.validation_runs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_type        public.validation_run_type NOT NULL DEFAULT 'full_cycle',
  status          public.validation_run_status NOT NULL DEFAULT 'pending',
  mode            TEXT NOT NULL DEFAULT 'deterministic',
  requested_by    TEXT,
  topology_run_id UUID REFERENCES public.data_quality_batch_runs (id) ON DELETE SET NULL,
  error_message   TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_validation_runs_started
  ON public.validation_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_validation_runs_status
  ON public.validation_runs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS public.validation_results (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id          UUID NOT NULL REFERENCES public.validation_runs (id) ON DELETE CASCADE,
  rule_code       TEXT REFERENCES public.data_quality_rules (rule_code),
  record_mrid     UUID,
  record_type     TEXT,
  outcome         TEXT NOT NULL,
  message         TEXT,
  details         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_validation_results_run
  ON public.validation_results (run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.cleanup_actions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exception_id    UUID REFERENCES public.data_quality_exceptions (id) ON DELETE SET NULL,
  run_id          UUID REFERENCES public.validation_runs (id) ON DELETE SET NULL,
  target_mrid     UUID,
  mode            public.cleanup_mode NOT NULL DEFAULT 'ASSISTED',
  status          public.cleanup_status NOT NULL DEFAULT 'proposed',
  plan            JSONB NOT NULL DEFAULT '{}'::jsonb,
  rollback_sql    TEXT,
  qgis_steps      TEXT,
  executed_by     TEXT,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  executed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cleanup_actions_status
  ON public.cleanup_actions (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.approval_requests (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cleanup_id      UUID REFERENCES public.cleanup_actions (id) ON DELETE CASCADE,
  exception_id    UUID REFERENCES public.data_quality_exceptions (id) ON DELETE SET NULL,
  status          public.approval_status NOT NULL DEFAULT 'pending',
  rationale       TEXT,
  decided_by      TEXT,
  decision_note   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_pending
  ON public.approval_requests (status, created_at DESC)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.agent_audit_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id          UUID REFERENCES public.validation_runs (id) ON DELETE SET NULL,
  agent_name      TEXT NOT NULL,
  tool_name       TEXT,
  policy_decision TEXT,
  input_hash      TEXT,
  output_summary  JSONB,
  model_id        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_audit_run
  ON public.agent_audit_log (run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.kpi_snapshot (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id                  UUID REFERENCES public.validation_runs (id) ON DELETE CASCADE,
  topology_validity_pct   DOUBLE PRECISION,
  completeness_pct        DOUBLE PRECISION,
  critical_exception_count BIGINT NOT NULL DEFAULT 0,
  open_exception_count    BIGINT NOT NULL DEFAULT 0,
  auto_fix_success_rate   DOUBLE PRECISION,
  pending_approval_count  BIGINT NOT NULL DEFAULT 0,
  export_blocked          BOOLEAN NOT NULL DEFAULT FALSE,
  escalation              JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kpi_snapshot_run
  ON public.kpi_snapshot (run_id);

CREATE INDEX IF NOT EXISTS idx_kpi_snapshot_created
  ON public.kpi_snapshot (created_at DESC);

-- Extend exception queue for agent routing.
ALTER TABLE public.data_quality_exceptions
  ADD COLUMN IF NOT EXISTS queue_name TEXT,
  ADD COLUMN IF NOT EXISTS cleanup_action_id UUID REFERENCES public.cleanup_actions (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_dq_exceptions_queue
  ON public.data_quality_exceptions (queue_name, status, created_at DESC)
  WHERE status = 'OPEN';

GRANT SELECT, INSERT, UPDATE ON public.validation_runs TO service_role, authenticated;
GRANT SELECT, INSERT ON public.validation_results TO service_role, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.cleanup_actions TO service_role, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.approval_requests TO service_role, authenticated;
GRANT SELECT, INSERT ON public.agent_audit_log TO service_role, authenticated;
GRANT SELECT, INSERT ON public.kpi_snapshot TO service_role, authenticated;
