-- AI/human-governed topology change proposals: dry-run → review → approve → publish to master.

DO $types$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'topology_proposal_status') THEN
    CREATE TYPE public.topology_proposal_status AS ENUM (
      'proposed', 'approved', 'rejected', 'published', 'failed'
    );
  END IF;
END;
$types$;

CREATE TABLE IF NOT EXISTS public.topology_change_proposals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exception_id    UUID REFERENCES public.data_quality_exceptions (id) ON DELETE SET NULL,
  cleanup_id      UUID REFERENCES public.cleanup_actions (id) ON DELETE CASCADE,
  approval_id     UUID REFERENCES public.approval_requests (id) ON DELETE SET NULL,
  target_mrid     UUID NOT NULL,
  rule_code       TEXT,
  proposed_by     TEXT NOT NULL DEFAULT 'CleanupAgent',
  ai_rationale    TEXT,
  dry_run_result  JSONB NOT NULL DEFAULT '{}'::jsonb,
  change_summary  JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          public.topology_proposal_status NOT NULL DEFAULT 'proposed',
  published_by    TEXT,
  published_at    TIMESTAMPTZ,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_topology_proposals_status
  ON public.topology_change_proposals (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_topology_proposals_cleanup
  ON public.topology_change_proposals (cleanup_id);

CREATE INDEX IF NOT EXISTS idx_topology_proposals_approval
  ON public.topology_change_proposals (approval_id);

GRANT SELECT, INSERT, UPDATE ON public.topology_change_proposals TO service_role, authenticated;
