-- AI steward scan metadata for endpoint fix proposals (DeepSeek / cleanup LLM).

ALTER TABLE gis.conductor_endpoint_proposals
  ADD COLUMN IF NOT EXISTS ai_rationale TEXT,
  ADD COLUMN IF NOT EXISTS ai_confidence TEXT
    CHECK (ai_confidence IS NULL OR ai_confidence IN ('high', 'medium', 'low')),
  ADD COLUMN IF NOT EXISTS ai_agrees BOOLEAN,
  ADD COLUMN IF NOT EXISTS ai_scan_id UUID;

CREATE TABLE IF NOT EXISTS gis.endpoint_fix_ai_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  district TEXT NOT NULL,
  proposal_batch_id UUID,
  model TEXT,
  llm_profile TEXT DEFAULT 'cleanup',
  status TEXT NOT NULL DEFAULT 'completed'
    CHECK (status IN ('running', 'completed', 'failed')),
  thoughts TEXT,
  transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviews JSONB NOT NULL DEFAULT '[]'::jsonb,
  proposals_reviewed INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_endpoint_fix_ai_scans_district_created
  ON gis.endpoint_fix_ai_scans (district, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON gis.endpoint_fix_ai_scans TO service_role;
GRANT UPDATE ON gis.conductor_endpoint_proposals TO service_role;
