-- FR-003: promote lineage, session-aware triggers, conducting_equipment coverage

CREATE OR REPLACE FUNCTION public.giop_set_lineage_context(
  p_source_type lineage_source_type DEFAULT NULL,
  p_operator_id TEXT DEFAULT NULL,
  p_provenance_ref TEXT DEFAULT NULL,
  p_skip BOOLEAN DEFAULT FALSE
)
RETURNS VOID AS $$
BEGIN
  PERFORM set_config('giop.skip_lineage', CASE WHEN p_skip THEN 'true' ELSE 'false' END, true);
  IF p_source_type IS NOT NULL THEN
    PERFORM set_config('giop.lineage_source', p_source_type::text, true);
  END IF;
  IF p_operator_id IS NOT NULL THEN
    PERFORM set_config('giop.lineage_operator', p_operator_id, true);
  END IF;
  IF p_provenance_ref IS NOT NULL THEN
    PERFORM set_config('giop.lineage_provenance', p_provenance_ref, true);
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.trg_lineage_identified_objects_fn()
RETURNS TRIGGER AS $$
DECLARE
  v_action TEXT;
  v_source lineage_source_type;
  v_operator TEXT;
  v_provenance TEXT;
BEGIN
  IF current_setting('giop.skip_lineage', true) = 'true' THEN
    RETURN NEW;
  END IF;

  v_operator := NULLIF(current_setting('giop.lineage_operator', true), '');
  IF v_operator IS NULL THEN
    v_operator := current_user;
  END IF;

  v_provenance := NULLIF(current_setting('giop.lineage_provenance', true), '');
  IF v_provenance IS NULL THEN
    v_provenance := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_action := 'INSERT';
    v_source := COALESCE(
      NULLIF(current_setting('giop.lineage_source', true), '')::lineage_source_type,
      'SYSTEM'::lineage_source_type
    );
    PERFORM public.log_data_lineage(
      NEW.mrid, v_source, v_action, v_operator, v_provenance,
      NULL, row_to_json(NEW)::jsonb
    );
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    v_action := 'UPDATE';
    v_source := COALESCE(
      NULLIF(current_setting('giop.lineage_source', true), '')::lineage_source_type,
      'MANUAL_EDIT'::lineage_source_type
    );
    PERFORM public.log_data_lineage(
      NEW.mrid, v_source, v_action, v_operator, v_provenance,
      row_to_json(OLD)::jsonb, row_to_json(NEW)::jsonb
    );
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.trg_lineage_conducting_equipment_fn()
RETURNS TRIGGER AS $$
DECLARE
  v_source lineage_source_type;
  v_operator TEXT;
  v_provenance TEXT;
BEGIN
  IF current_setting('giop.skip_lineage', true) = 'true' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.nominal_voltage IS NOT DISTINCT FROM NEW.nominal_voltage
     AND OLD.phases IS NOT DISTINCT FROM NEW.phases THEN
    RETURN NEW;
  END IF;

  v_operator := NULLIF(current_setting('giop.lineage_operator', true), '');
  IF v_operator IS NULL THEN
    v_operator := current_user;
  END IF;
  v_provenance := COALESCE(
    NULLIF(current_setting('giop.lineage_provenance', true), ''),
    TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME
  );
  v_source := COALESCE(
    NULLIF(current_setting('giop.lineage_source', true), '')::lineage_source_type,
    'MANUAL_EDIT'::lineage_source_type
  );

  PERFORM public.log_data_lineage(
    NEW.mrid, v_source, 'EQUIPMENT_UPDATE', v_operator, v_provenance,
    row_to_json(OLD)::jsonb, row_to_json(NEW)::jsonb
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lineage_public_conducting_equipment ON public.conducting_equipment;
CREATE TRIGGER trg_lineage_public_conducting_equipment
  AFTER UPDATE ON public.conducting_equipment
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_lineage_conducting_equipment_fn();

CREATE OR REPLACE FUNCTION promote_staged_asset(target_mrid UUID)
RETURNS JSONB AS $$
DECLARE
  v_validation staging_validation_state;
  v_before JSONB;
  v_operator TEXT;
BEGIN
  SELECT validation INTO v_validation
  FROM staging.identified_objects
  WHERE mrid = target_mrid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Staging asset % not found', target_mrid;
  END IF;

  IF v_validation = 'IN_CONFLICT' THEN
    RAISE EXCEPTION 'Cannot promote asset % in IN_CONFLICT state', target_mrid;
  END IF;

  IF v_validation NOT IN ('PENDING_FIELD', 'STAGED') THEN
    RAISE EXCEPTION 'Asset % is not promotable (validation=%)', target_mrid, v_validation;
  END IF;

  IF EXISTS (SELECT 1 FROM public.identified_objects WHERE mrid = target_mrid) THEN
    RAISE EXCEPTION 'Master already contains asset %', target_mrid;
  END IF;

  SELECT jsonb_build_object(
    'identified_object', row_to_json(io)::jsonb,
    'connectivity_node', (
      SELECT row_to_json(cn)::jsonb
      FROM staging.connectivity_nodes cn
      WHERE cn.mrid = target_mrid
    ),
    'ghana_grid_asset', (
      SELECT row_to_json(ga)::jsonb
      FROM staging.ghana_grid_assets ga
      WHERE ga.mrid = target_mrid
    )
  ) INTO v_before
  FROM staging.identified_objects io
  WHERE io.mrid = target_mrid;

  v_operator := NULLIF(current_setting('giop.lineage_operator', true), '');

  PERFORM set_config('giop.skip_lineage', 'true', true);

  INSERT INTO public.identified_objects (mrid, name, lifecycle_state, validation, error_log, updated_at)
  SELECT mrid, name, lifecycle_state, 'APPROVED', error_log, NOW()
  FROM staging.identified_objects
  WHERE mrid = target_mrid;

  INSERT INTO public.connectivity_nodes (mrid, boundary_feeder_id, geom)
  SELECT mrid, boundary_feeder_id, geom
  FROM staging.connectivity_nodes
  WHERE mrid = target_mrid;

  INSERT INTO public.ghana_grid_assets (mrid, operating_utility, substation_name)
  SELECT mrid, operating_utility, substation_name
  FROM staging.ghana_grid_assets
  WHERE mrid = target_mrid;

  PERFORM public.log_data_lineage(
    target_mrid,
    'PROMOTE'::lineage_source_type,
    'STAGING_TO_MASTER',
    v_operator,
    'promote_staged_asset()',
    v_before,
    jsonb_build_object('validation', 'APPROVED', 'tier', 'master', 'promoted', true)
  );

  DELETE FROM staging.identified_objects WHERE mrid = target_mrid;

  PERFORM set_config('giop.skip_lineage', 'false', true);

  RETURN jsonb_build_object(
    'mrid', target_mrid,
    'validation', 'APPROVED',
    'promoted', true
  );
END;
$$ LANGUAGE plpgsql;

CREATE INDEX IF NOT EXISTS idx_data_lineage_created ON public.data_lineage (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_lineage_action ON public.data_lineage (action_type, created_at DESC);
