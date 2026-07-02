-- DQ → Operations handoff: only STAGED staging assets may promote to master.
-- Field captures land as PENDING_FIELD (Data Quality); stewards release to STAGED
-- before Operations approval.

CREATE OR REPLACE FUNCTION promote_staged_asset(target_mrid UUID)
RETURNS JSONB AS $$
DECLARE
  v_validation staging_validation_state;
  v_asset_kind TEXT;
  v_geom GEOMETRY(Point, 4326);
  v_gis_layer TEXT;
  v_source_fid BIGINT;
  v_before JSONB;
  v_operator TEXT;
  v_deferred JSONB;
BEGIN
  SELECT io.validation INTO v_validation
  FROM staging.identified_objects io
  WHERE io.mrid = target_mrid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Staging asset % not found', target_mrid;
  END IF;

  IF v_validation = 'IN_CONFLICT' THEN
    RAISE EXCEPTION 'Cannot promote asset % in IN_CONFLICT state', target_mrid;
  END IF;

  IF v_validation <> 'STAGED' THEN
    RAISE EXCEPTION
      'Asset % must be released from Data Quality (STAGED) before promotion (validation=%)',
      target_mrid, v_validation;
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

  SELECT staging.apply_deferred_master_repairs(target_mrid) INTO v_deferred;

  SELECT COALESCE(ga.asset_kind, 'connectivity_node'), cn.geom
  INTO v_asset_kind, v_geom
  FROM staging.ghana_grid_assets ga
  JOIN staging.connectivity_nodes cn ON cn.mrid = ga.mrid
  WHERE ga.mrid = target_mrid;

  v_gis_layer := staging.field_asset_kind_to_gis_layer(v_asset_kind);
  IF v_gis_layer IS NOT NULL AND v_geom IS NOT NULL THEN
    v_source_fid := -(abs(hashtext(target_mrid::text)) % 1000000000);
    INSERT INTO gis.asset_id_map (source_layer, source_fid, source_unique_id, mrid, geom)
    VALUES (v_gis_layer, v_source_fid, target_mrid::text, target_mrid, v_geom)
    ON CONFLICT (source_layer, source_fid) DO UPDATE
      SET mrid = EXCLUDED.mrid, geom = EXCLUDED.geom, source_unique_id = EXCLUDED.source_unique_id;
  END IF;

  PERFORM public.log_data_lineage(
    target_mrid,
    'PROMOTE'::lineage_source_type,
    'STAGING_TO_MASTER',
    v_operator,
    'promote_staged_asset()',
    v_before,
    jsonb_build_object(
      'validation', 'APPROVED',
      'tier', 'master',
      'promoted', true,
      'deferred_master_repairs', v_deferred
    )
  );

  DELETE FROM staging.identified_objects WHERE mrid = target_mrid;

  PERFORM set_config('giop.skip_lineage', 'false', true);

  RETURN jsonb_build_object(
    'mrid', target_mrid,
    'validation', 'APPROVED',
    'promoted', true,
    'asset_kind', v_asset_kind,
    'deferred_master_repairs', v_deferred
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION promote_staged_line_segment(target_mrid UUID)
RETURNS JSONB AS $$
DECLARE
  v_validation staging_validation_state;
  v_source UUID;
  v_target UUID;
  v_geom GEOMETRY(LineString, 4326);
  v_feeder TEXT;
  v_name TEXT;
  v_voltage ghana_voltage_enum := 'LV_400V';
BEGIN
  SELECT io.validation, io.name, ls.source_node_id, ls.target_node_id, ls.geom, ls.boundary_feeder_id
  INTO v_validation, v_name, v_source, v_target, v_geom, v_feeder
  FROM staging.identified_objects io
  JOIN staging.ac_line_segments ls ON ls.mrid = io.mrid
  WHERE io.mrid = target_mrid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Staging line % not found', target_mrid;
  END IF;

  IF v_validation <> 'STAGED' THEN
    RAISE EXCEPTION
      'Line % must be released from Data Quality (STAGED) before promotion (validation=%)',
      target_mrid, v_validation;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.connectivity_nodes WHERE mrid = v_source) THEN
    RAISE EXCEPTION 'Source node % not in master — promote poles first', v_source;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.connectivity_nodes WHERE mrid = v_target) THEN
    RAISE EXCEPTION 'Target node % not in master — promote poles first', v_target;
  END IF;

  PERFORM set_config('giop.skip_lineage', 'true', true);

  INSERT INTO public.identified_objects (mrid, name, lifecycle_state, validation)
  VALUES (target_mrid, COALESCE(v_name, 'Field span'), 'IN_SERVICE', 'APPROVED');

  INSERT INTO public.conducting_equipment (mrid, phases, nominal_voltage)
  VALUES (target_mrid, 'ABC', v_voltage);

  INSERT INTO public.ac_line_segments (mrid, source_node_id, target_node_id, direction_downstream, geom)
  VALUES (target_mrid, v_source, v_target, TRUE, v_geom);

  DELETE FROM staging.identified_objects WHERE mrid = target_mrid;

  PERFORM set_config('giop.skip_lineage', 'false', true);

  RETURN jsonb_build_object('mrid', target_mrid, 'promoted', true, 'tier', 'master');
END;
$$ LANGUAGE plpgsql;
