-- FR-020: data cleansing & validation — rule catalogue + exception queue.

DO $types$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dq_severity') THEN
    CREATE TYPE public.dq_severity AS ENUM ('critical', 'major', 'minor', 'warning');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dq_exception_status') THEN
    CREATE TYPE public.dq_exception_status AS ENUM (
      'OPEN', 'DEFERRED', 'QUARANTINED', 'RESOLVED', 'REJECTED'
    );
  END IF;
END;
$types$;

-- Configurable rule catalogue (stewards can enable/disable, set blocking).
CREATE TABLE IF NOT EXISTS public.data_quality_rules (
  rule_code         TEXT PRIMARY KEY,
  domain            TEXT NOT NULL,
  severity          public.dq_severity NOT NULL DEFAULT 'major',
  description       TEXT NOT NULL,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  blocks_promotion  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Exception queue: one row per (record, rule) finding.
CREATE TABLE IF NOT EXISTS public.data_quality_exceptions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  record_type     TEXT NOT NULL,
  record_mrid     UUID NOT NULL,
  rule_code       TEXT NOT NULL REFERENCES public.data_quality_rules (rule_code),
  severity        public.dq_severity NOT NULL,
  status          public.dq_exception_status NOT NULL DEFAULT 'OPEN',
  error_message   TEXT NOT NULL,
  details         JSONB,
  owner           TEXT,
  resolution_note TEXT,
  resolved_by     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);

-- At most one OPEN exception per (record, rule) to keep the queue idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dq_exceptions_open_unique
  ON public.data_quality_exceptions (record_mrid, rule_code)
  WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS idx_dq_exceptions_status
  ON public.data_quality_exceptions (status, severity, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dq_exceptions_record
  ON public.data_quality_exceptions (record_mrid, created_at DESC);

-- Seed the starter rule pack (FR-020 §6.20). Idempotent.
INSERT INTO public.data_quality_rules (rule_code, domain, severity, description, blocks_promotion) VALUES
  ('ASSET_NAME_REQUIRED',   'asset',    'critical', 'Asset name must be present and non-empty.',                 TRUE),
  ('ASSET_GEOM_REQUIRED',   'spatial',  'critical', 'Connectivity node must have a valid point geometry.',       TRUE),
  ('ASSET_GEOM_IN_GHANA',   'spatial',  'major',    'Coordinates must fall within the Ghana operating bbox.',    TRUE),
  ('ASSET_FEEDER_REQUIRED', 'asset',    'major',    'Connectivity node should declare a boundary feeder id.',    FALSE),
  ('ASSET_ORPHAN_NODE',     'topology', 'major',    'Master node has no connected line segment (orphan).',       FALSE),
  ('EQUIP_VOLTAGE_PRESENT', 'voltage',  'major',    'Conducting equipment must declare a nominal voltage.',      FALSE),
  ('ASSET_DUPLICATE_NEAR',  'asset',    'major',    'Possible duplicate: another asset within 5m with a similar name.', FALSE)
ON CONFLICT (rule_code) DO NOTHING;

GRANT SELECT ON public.data_quality_rules TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.data_quality_exceptions TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.data_quality_rules TO service_role;
