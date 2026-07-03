-- Field-capture DQ exceptions belong in staging, not the master exception queue.
-- Master assets continue to use public.data_quality_exceptions.

CREATE TABLE IF NOT EXISTS staging.data_quality_exceptions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  record_type     TEXT NOT NULL,
  record_mrid     UUID NOT NULL REFERENCES staging.identified_objects (mrid) ON DELETE CASCADE,
  rule_code       TEXT NOT NULL REFERENCES public.data_quality_rules (rule_code),
  severity        public.dq_severity NOT NULL,
  status          public.dq_exception_status NOT NULL DEFAULT 'OPEN',
  error_message   TEXT NOT NULL,
  details         JSONB,
  owner           TEXT,
  resolution_note TEXT,
  resolved_by     TEXT,
  queue_name      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_staging_dq_exceptions_open_unique
  ON staging.data_quality_exceptions (record_mrid, rule_code)
  WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS idx_staging_dq_exceptions_status
  ON staging.data_quality_exceptions (status, severity, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staging_dq_exceptions_record
  ON staging.data_quality_exceptions (record_mrid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staging_dq_exceptions_queue
  ON staging.data_quality_exceptions (queue_name, status, created_at DESC)
  WHERE status = 'OPEN';

GRANT SELECT, INSERT, UPDATE ON staging.data_quality_exceptions TO anon, authenticated, service_role;

-- Move existing staging-asset exceptions out of the master queue (preserve ids).
INSERT INTO staging.data_quality_exceptions (
  id, record_type, record_mrid, rule_code, severity, status, error_message,
  details, owner, resolution_note, resolved_by, queue_name, created_at, resolved_at
)
SELECT
  e.id, e.record_type, e.record_mrid, e.rule_code, e.severity, e.status, e.error_message,
  e.details, e.owner, e.resolution_note, e.resolved_by, e.queue_name, e.created_at, e.resolved_at
FROM public.data_quality_exceptions e
WHERE EXISTS (
  SELECT 1 FROM staging.identified_objects sio WHERE sio.mrid = e.record_mrid
)
ON CONFLICT (id) DO NOTHING;

DELETE FROM public.data_quality_exceptions e
WHERE EXISTS (
  SELECT 1 FROM staging.identified_objects sio WHERE sio.mrid = e.record_mrid
);

-- Drop legacy orphans (staging row gone, never promoted).
DELETE FROM public.data_quality_exceptions e
WHERE NOT EXISTS (
  SELECT 1 FROM public.identified_objects pio WHERE pio.mrid = e.record_mrid
);
