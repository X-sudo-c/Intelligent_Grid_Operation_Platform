-- Reject workflow for staging assets + field technician live positions.

ALTER TYPE staging_validation_state ADD VALUE IF NOT EXISTS 'REJECTED';

ALTER TABLE staging.identified_objects
  ADD COLUMN IF NOT EXISTS submitted_by TEXT;

CREATE INDEX IF NOT EXISTS idx_staging_submitted_by
  ON staging.identified_objects (submitted_by)
  WHERE submitted_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.field_technician_positions (
  technician_id TEXT PRIMARY KEY,
  display_name TEXT,
  longitude DOUBLE PRECISION NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  accuracy_m DOUBLE PRECISION,
  heading_deg DOUBLE PRECISION,
  speed_mps DOUBLE PRECISION,
  work_order_id TEXT,
  session_started_at TIMESTAMPTZ,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_field_tech_positions_reported
  ON public.field_technician_positions (reported_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.field_technician_positions TO anon, authenticated, service_role;

ALTER PUBLICATION supabase_realtime ADD TABLE public.field_technician_positions;

COMMENT ON TABLE public.field_technician_positions IS
  'Latest reported GPS position per field technician (upserted by mobile clients).';
COMMENT ON COLUMN staging.identified_objects.submitted_by IS
  'Operator/technician identifier from field capture; replaced by auth subject later.';
