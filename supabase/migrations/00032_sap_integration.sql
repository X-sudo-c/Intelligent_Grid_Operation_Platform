-- Mock / real SAP customer sync (FR-019 foundation).

ALTER TYPE integration_dlq_source ADD VALUE IF NOT EXISTS 'SAP';

ALTER TABLE public.customer_accounts
  ADD COLUMN IF NOT EXISTS sap_business_partner_id TEXT,
  ADD COLUMN IF NOT EXISTS source_system TEXT NOT NULL DEFAULT 'GIOP',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_accounts_sap_bp
  ON public.customer_accounts (sap_business_partner_id)
  WHERE sap_business_partner_id IS NOT NULL;

COMMENT ON COLUMN public.customer_accounts.sap_business_partner_id IS
  'SAP Business Partner / customer master key when synced from S/4HANA.';

CREATE TABLE IF NOT EXISTS public.sap_sync_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sync_type TEXT NOT NULL DEFAULT 'customers',
  mode TEXT NOT NULL DEFAULT 'mock',
  status TEXT NOT NULL DEFAULT 'running',
  fetched_count INTEGER NOT NULL DEFAULT 0,
  upserted_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sap_sync_runs_started
  ON public.sap_sync_runs (started_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.sap_sync_runs TO authenticated, service_role;
GRANT UPDATE ON public.customer_accounts TO service_role;
