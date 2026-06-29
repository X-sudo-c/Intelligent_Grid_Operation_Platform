-- CIM mapping register + export job helper (FR-019 / enterprise interchange).

CREATE TABLE IF NOT EXISTS public.cim_mapping_register (
  id                   SERIAL PRIMARY KEY,
  canonical_object     TEXT NOT NULL,
  cim_class            TEXT NOT NULL,
  cim_profile          TEXT,
  local_schema         TEXT NOT NULL,
  local_field          TEXT NOT NULL,
  source_system        TEXT NOT NULL DEFAULT 'GIOP',
  target_system        TEXT NOT NULL DEFAULT 'enterprise',
  transformation_rule  TEXT NOT NULL,
  owner                TEXT,
  approval_status      TEXT NOT NULL DEFAULT 'approved',
  reviewed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (local_schema, local_field, canonical_object)
);

COMMENT ON TABLE public.cim_mapping_register IS
  'Documented CIM profile mappings for integration and export payloads (FR-019).';

INSERT INTO public.cim_mapping_register (
  canonical_object, cim_class, cim_profile, local_schema, local_field,
  transformation_rule, owner
) VALUES
  ('ConnectivityNode', 'ConnectivityNode', 'IEC61970-452', 'public', 'connectivity_nodes.mrid',
   'UUID mrid is IdentifiedObject.mRID', 'GIS'),
  ('ConnectivityNode', 'ConnectivityNode', 'IEC61970-452', 'public', 'connectivity_nodes.boundary_feeder_id',
   'Local feeder circuit id; maps to Feeder/Circuit at integration boundary', 'GIS'),
  ('IdentifiedObject', 'IdentifiedObject', 'IEC61970-452', 'public', 'identified_objects.name',
   'Direct CIM name attribute', 'MDM'),
  ('IdentifiedObject', 'IdentifiedObject', 'IEC61970-452', 'public', 'identified_objects.lifecycle_state',
   'CIM lifecycleState code set (local enum)', 'MDM'),
  ('ConductingEquipment', 'ConductingEquipment', 'IEC61970-452', 'public', 'conducting_equipment.nominal_voltage',
   'ghana_voltage_enum → CIM Voltage level at boundary', 'GIS'),
  ('ConductingEquipment', 'ConductingEquipment', 'IEC61970-452', 'public', 'conducting_equipment.phases',
   'CIM PhaseCode string', 'GIS'),
  ('ACLineSegment', 'ACLineSegment', 'IEC61970-452', 'public', 'ac_line_segments.source_node_id',
   'Terminal connectivity: source ConnectivityNode.mrid', 'GIS'),
  ('ACLineSegment', 'ACLineSegment', 'IEC61970-452', 'public', 'ac_line_segments.target_node_id',
   'Terminal connectivity: target ConnectivityNode.mrid', 'GIS'),
  ('UsagePoint', 'UsagePoint', 'IEC61968', 'public', 'usage_points.mrid',
   'UsagePoint IdentifiedObject.mRID', 'MDMS'),
  ('Meter', 'Meter', 'IEC61968-9', 'public', 'meters.mrid',
   'Meter IdentifiedObject.mRID', 'MDMS'),
  ('GhanaGridAsset', 'PowerSystemResource', 'GIOP-Extension', 'public', 'ghana_grid_assets.operating_utility',
   'ghana_utility_enum local extension', 'GIS')
ON CONFLICT (local_schema, local_field, canonical_object) DO NOTHING;

GRANT SELECT ON public.cim_mapping_register TO anon, authenticated, service_role;

-- Enqueue export work (called from sync-service after job insert).
CREATE OR REPLACE FUNCTION public.enqueue_gis_export_job(p_job_id UUID)
RETURNS BIGINT AS $$
DECLARE
  v_msg_id BIGINT;
BEGIN
  SELECT pgmq.send(
    'gis_export_jobs',
    jsonb_build_object('job_id', p_job_id::text)
  ) INTO v_msg_id;
  RETURN v_msg_id;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION public.enqueue_gis_export_job(UUID) TO service_role;
