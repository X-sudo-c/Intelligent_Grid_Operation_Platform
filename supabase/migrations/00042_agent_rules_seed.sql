-- Expanded DQ rule catalogue (≥25 rules) for multi-agent validation engine.

ALTER TABLE public.data_quality_rules
  ADD COLUMN IF NOT EXISTS autofix_allowed BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE public.data_quality_rules
SET autofix_allowed = TRUE
WHERE rule_code IN ('ASSET_ORPHAN_NODE');

INSERT INTO public.data_quality_rules (rule_code, domain, severity, description, blocks_promotion, autofix_allowed) VALUES
  ('TRANSFORMER_CAPACITY_NOT_NULL', 'asset', 'major', 'Transformer must declare rated capacity.', FALSE, FALSE),
  ('ASSET_GEOM_VALID', 'spatial', 'critical', 'Asset geometry must pass ST_IsValid.', TRUE, FALSE),
  ('ASSET_IN_SERVICE_BOUNDARY', 'spatial', 'major', 'Asset must fall within an ECG admin region.', FALSE, FALSE),
  ('TRANSFORMER_CONNECTED_TO_FEEDER', 'topology', 'major', 'Transformer node must trace to a feeder.', FALSE, FALSE),
  ('FEEDER_NO_DISCONNECTED_SEGMENTS', 'topology', 'critical', 'Feeder must not contain disconnected line segments.', TRUE, FALSE),
  ('TOPO_NETWORK_LOOP', 'topology', 'major', 'Unexpected network loop detected.', FALSE, FALSE),
  ('TOPO_ISLAND_COMPONENT', 'topology', 'major', 'Small disconnected island component detected.', FALSE, FALSE),
  ('LINE_ENDPOINTS_EXIST', 'referential', 'critical', 'Line segment endpoints must reference existing nodes.', TRUE, FALSE),
  ('CUSTOMER_TRACEABLE_TO_TRANSFORMER', 'customer', 'major', 'Customer must trace to a distribution transformer.', TRUE, FALSE),
  ('METER_VALID_CUSTOMER', 'meter', 'critical', 'Meter must reference a valid customer account.', TRUE, FALSE),
  ('CUSTOMER_VALID_TRANSFORMER', 'customer', 'major', 'Customer must reference a valid transformer.', TRUE, FALSE),
  ('ASSET_ID_UNIQUE', 'asset', 'critical', 'Asset MRID must be unique in master registry.', TRUE, FALSE),
  ('METER_SERIAL_UNIQUE', 'meter', 'major', 'Meter serial number must be unique.', FALSE, FALSE),
  ('CUSTOMER_NAME_REQUIRED', 'customer', 'major', 'Customer name must be present.', FALSE, FALSE),
  ('METER_SERIAL_REQUIRED', 'meter', 'major', 'Meter serial number must be present.', FALSE, FALSE),
  ('USAGE_POINT_GEOM_REQUIRED', 'spatial', 'major', 'Usage point must have valid geometry.', FALSE, FALSE),
  ('PHASES_CONSISTENT', 'voltage', 'minor', 'Line phase count must match connected equipment.', FALSE, FALSE),
  ('VOLTAGE_LEVEL_CONSISTENT', 'voltage', 'major', 'Connected equipment voltages must be compatible.', FALSE, FALSE),
  ('SAP_BP_RECONCILIATION', 'cross_system', 'major', 'Customer must reconcile to SAP business partner.', FALSE, FALSE),
  ('MDMS_METER_RECONCILIATION', 'cross_system', 'major', 'Meter must reconcile to MDMS register.', FALSE, FALSE),
  ('TIMELINESS_STALE_ASSET', 'timeliness', 'warning', 'Asset not updated within expected interval.', FALSE, FALSE),
  ('DUPLICATE_CUSTOMER_ACCOUNT', 'customer', 'major', 'Possible duplicate customer account.', FALSE, FALSE),
  ('DUPLICATE_METER_SERIAL', 'meter', 'critical', 'Duplicate meter serial in master.', TRUE, FALSE),
  ('BILLING_ACCOUNT_ACTIVE', 'billing', 'critical', 'Billing account must be active for in-service meter.', TRUE, FALSE),
  ('FEEDER_TRACE_COMPLETE', 'topology', 'major', 'Feeder trace must reach a source substation.', FALSE, FALSE)
ON CONFLICT (rule_code) DO NOTHING;
