-- Field push notifications: device tokens + delivery tracking on notification_log.

CREATE TABLE IF NOT EXISTS public.field_device_tokens (
  technician_id TEXT NOT NULL,
  token TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'android',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (technician_id, token)
);

CREATE INDEX IF NOT EXISTS idx_field_device_tokens_technician
  ON public.field_device_tokens (technician_id);

ALTER TABLE public.notification_log
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_notification_log_recipient_pending
  ON public.notification_log (recipient, created_at DESC)
  WHERE read_at IS NULL;

ALTER PUBLICATION supabase_realtime ADD TABLE public.notification_log;

GRANT SELECT, INSERT, UPDATE ON public.field_device_tokens TO anon, authenticated, service_role;
GRANT SELECT, UPDATE ON public.notification_log TO anon, authenticated, service_role;

COMMENT ON TABLE public.field_device_tokens IS
  'FCM/APNs device tokens for field technician push (optional; polling fallback when unset).';
