-- Swarm claiming for parallel endpoint-fix AI scan workers (SKIP LOCKED).

ALTER TABLE gis.conductor_endpoint_proposals
  ADD COLUMN IF NOT EXISTS ai_claim_token UUID,
  ADD COLUMN IF NOT EXISTS ai_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_claim_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_endpoint_proposals_ai_claim_pending
  ON gis.conductor_endpoint_proposals (district, status)
  WHERE status = 'pending' AND ai_rationale IS NULL;

ALTER TABLE gis.endpoint_fix_ai_runs
  ADD COLUMN IF NOT EXISTS swarm_workers INTEGER NOT NULL DEFAULT 4;

COMMENT ON COLUMN gis.conductor_endpoint_proposals.ai_claim_token IS
  'Short-lived claim for parallel AI scan workers; cleared when ai_rationale is set.';
