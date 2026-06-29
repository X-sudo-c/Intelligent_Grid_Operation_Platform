-- Disable noisy FEEDER_NO_DISCONNECTED_SEGMENTS on partial imports (duplicates orphan detection).

UPDATE public.data_quality_rules
SET
  enabled = FALSE,
  severity = 'major'::public.dq_severity,
  description = 'Feeder must not contain disconnected line segments. Disabled by default on partial imports — overlaps ASSET_ORPHAN_NODE; re-enable after feeder graph is fully wired.'
WHERE rule_code = 'FEEDER_NO_DISCONNECTED_SEGMENTS';

-- Optional: defer existing open FEEDER exceptions so KPI critical count reflects actionable items.
UPDATE public.data_quality_exceptions
SET status = 'DEFERRED',
    resolution_note = 'Bulk-deferred: rule disabled pending feeder graph wiring',
    resolved_at = NOW(),
    resolved_by = 'system'
WHERE rule_code = 'FEEDER_NO_DISCONNECTED_SEGMENTS'
  AND status = 'OPEN';
