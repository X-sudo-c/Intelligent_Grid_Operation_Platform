-- FR-005: real topology repair in staging (preview + apply) with map-friendly GeoJSON.

ALTER TABLE staging.identified_objects
  ADD COLUMN IF NOT EXISTS repair_proposals JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN staging.identified_objects.repair_proposals IS
  'Deferred master-network segment snaps to apply when this staging asset is promoted.';

-- Enrich master repair proposals with before/after geometry for map preview.
CREATE OR REPLACE FUNCTION public.repair_asset_topology_and_attributes(
  target_uuid UUID,
  radius_meters DOUBLE PRECISION DEFAULT 50,
  p_dry_run BOOLEAN DEFAULT FALSE
)
RETURNS JSONB AS $$
DECLARE
  repairs JSONB := '[]'::JSONB;
  proposed JSONB := '[]'::JSONB;
  applied JSONB := '[]'::JSONB;
  skipped JSONB := '[]'::JSONB;
  seg RECORD;
  v_node_geom geometry;
  v_is_node BOOLEAN := FALSE;
  v_new_source UUID;
  v_new_target UUID;
  v_near_mrid UUID;
  v_near_geom geometry;
  v_dist_m DOUBLE PRECISION;
  v_action JSONB;
  v_new_geom geometry;
  v_changed BOOLEAN;
BEGIN
  IF NOT p_dry_run THEN
    UPDATE public.conducting_equipment ce
    SET serial_number = regexp_replace(ce.serial_number, '^([A-Z]+)(\d+)$', '\1-\2')
    FROM public.identified_objects io
    WHERE ce.mrid = io.mrid
      AND io.mrid = target_uuid
      AND ce.serial_number ~ '^[A-Z]+\d+$';
    IF FOUND THEN
      repairs := repairs || jsonb_build_array(jsonb_build_object('pass', 1, 'action', 'serial_normalized'));
    END IF;
  END IF;

  SELECT cn.geom INTO v_node_geom
  FROM public.connectivity_nodes cn
  WHERE cn.mrid = target_uuid;
  v_is_node := FOUND;

  FOR seg IN
    SELECT DISTINCT ON (als.mrid)
      als.mrid,
      als.source_node_id,
      als.target_node_id,
      als.geom
    FROM public.ac_line_segments als
    WHERE (
      v_is_node
      AND (
        ST_DWithin(ST_StartPoint(als.geom)::geography, v_node_geom::geography, radius_meters)
        OR ST_DWithin(ST_EndPoint(als.geom)::geography, v_node_geom::geography, radius_meters)
        OR als.source_node_id = target_uuid
        OR als.target_node_id = target_uuid
      )
    )
    OR als.mrid = target_uuid
    ORDER BY als.mrid
  LOOP
    v_new_source := seg.source_node_id;
    v_new_target := seg.target_node_id;
    v_action := jsonb_build_object('segment_mrid', seg.mrid, 'segment_tier', 'master');
    v_changed := FALSE;

    IF v_is_node
       AND ST_DWithin(ST_StartPoint(seg.geom)::geography, v_node_geom::geography, radius_meters)
       AND v_new_target IS DISTINCT FROM target_uuid
    THEN
      v_dist_m := ST_Distance(ST_StartPoint(seg.geom)::geography, v_node_geom::geography);
      IF v_new_source IS DISTINCT FROM target_uuid THEN
        v_new_source := target_uuid;
        v_action := v_action || jsonb_build_object(
          'link_start_to', target_uuid, 'start_dist_m', round(v_dist_m::numeric, 2)
        );
        v_changed := TRUE;
      END IF;
    ELSE
      SELECT cn.mrid, cn.geom,
             ST_Distance(ST_StartPoint(seg.geom)::geography, cn.geom::geography)
      INTO v_near_mrid, v_near_geom, v_dist_m
      FROM public.connectivity_nodes cn
      WHERE cn.mrid IS DISTINCT FROM seg.target_node_id
      ORDER BY cn.geom <-> ST_StartPoint(seg.geom)
      LIMIT 1;
      IF v_near_mrid IS NOT NULL
         AND v_dist_m <= radius_meters
         AND v_new_source IS DISTINCT FROM v_near_mrid
      THEN
        v_new_source := v_near_mrid;
        v_action := v_action || jsonb_build_object(
          'link_start_to', v_near_mrid, 'start_dist_m', round(v_dist_m::numeric, 2)
        );
        v_changed := TRUE;
      END IF;
    END IF;

    IF v_is_node
       AND ST_DWithin(ST_EndPoint(seg.geom)::geography, v_node_geom::geography, radius_meters)
       AND v_new_source IS DISTINCT FROM target_uuid
    THEN
      v_dist_m := ST_Distance(ST_EndPoint(seg.geom)::geography, v_node_geom::geography);
      IF v_new_target IS DISTINCT FROM target_uuid THEN
        v_new_target := target_uuid;
        v_action := v_action || jsonb_build_object(
          'link_end_to', target_uuid, 'end_dist_m', round(v_dist_m::numeric, 2)
        );
        v_changed := TRUE;
      END IF;
    ELSE
      SELECT cn.mrid, cn.geom,
             ST_Distance(ST_EndPoint(seg.geom)::geography, cn.geom::geography)
      INTO v_near_mrid, v_near_geom, v_dist_m
      FROM public.connectivity_nodes cn
      WHERE cn.mrid IS DISTINCT FROM v_new_source
      ORDER BY cn.geom <-> ST_EndPoint(seg.geom)
      LIMIT 1;
      IF v_near_mrid IS NOT NULL
         AND v_dist_m <= radius_meters
         AND v_new_target IS DISTINCT FROM v_near_mrid
      THEN
        v_new_target := v_near_mrid;
        v_action := v_action || jsonb_build_object(
          'link_end_to', v_near_mrid, 'end_dist_m', round(v_dist_m::numeric, 2)
        );
        v_changed := TRUE;
      END IF;
    END IF;

    IF v_new_source IS NOT NULL AND v_new_target IS NOT NULL AND v_new_source = v_new_target THEN
      skipped := skipped || jsonb_build_array(v_action || jsonb_build_object('reason', 'self_loop'));
      CONTINUE;
    END IF;

    IF v_new_source IS NOT NULL AND v_new_target IS NOT NULL THEN
      SELECT ST_SetSRID(ST_MakeLine(src.geom, tgt.geom), 4326)
      INTO v_new_geom
      FROM public.connectivity_nodes src
      JOIN public.connectivity_nodes tgt ON tgt.mrid = v_new_target
      WHERE src.mrid = v_new_source;

      IF v_new_geom IS NOT NULL AND (
        v_changed
        OR ST_Distance(ST_StartPoint(seg.geom)::geography, (SELECT geom FROM public.connectivity_nodes WHERE mrid = v_new_source)::geography) > 1
        OR ST_Distance(ST_EndPoint(seg.geom)::geography, (SELECT geom FROM public.connectivity_nodes WHERE mrid = v_new_target)::geography) > 1
      ) THEN
        v_action := v_action || jsonb_build_object(
          'source_node_id', v_new_source,
          'target_node_id', v_new_target,
          'geom_snapped', TRUE,
          'geom_before', ST_AsGeoJSON(seg.geom)::jsonb,
          'geom_after', ST_AsGeoJSON(v_new_geom)::jsonb
        );
        IF p_dry_run THEN
          proposed := proposed || jsonb_build_array(v_action);
        ELSE
          UPDATE public.ac_line_segments
          SET source_node_id = v_new_source,
              target_node_id = v_new_target,
              geom = v_new_geom
          WHERE mrid = seg.mrid
            AND (
              source_node_id IS DISTINCT FROM v_new_source
              OR target_node_id IS DISTINCT FROM v_new_target
              OR geom IS DISTINCT FROM v_new_geom
            );
          IF FOUND THEN
            applied := applied || jsonb_build_array(v_action);
            repairs := repairs || jsonb_build_array(v_action);
          END IF;
        END IF;
      ELSIF v_changed THEN
        IF p_dry_run THEN
          proposed := proposed || jsonb_build_array(v_action);
        ELSE
          skipped := skipped || jsonb_build_array(v_action || jsonb_build_object('reason', 'missing_node_geom'));
        END IF;
      END IF;
    END IF;
  END LOOP;

  IF v_is_node AND NOT p_dry_run AND jsonb_array_length(applied) > 0 THEN
    UPDATE public.identified_objects
    SET updated_at = NOW()
    WHERE mrid = target_uuid;
  END IF;

  RETURN jsonb_build_object(
    'target_mrid', target_uuid,
    'tier', 'master',
    'dry_run', p_dry_run,
    'target_kind', CASE
      WHEN v_is_node THEN 'connectivity_node'
      WHEN EXISTS (SELECT 1 FROM public.ac_line_segments WHERE mrid = target_uuid) THEN 'ac_line_segment'
      ELSE 'conducting_equipment'
    END,
    'repairs', repairs,
    'proposed', proposed,
    'applied', applied,
    'skipped', skipped,
    'radius_meters', radius_meters
  );
END;
$$ LANGUAGE plpgsql;

-- Staging repair: snap staging segments + preview/queue master segment snaps (applied on promote).
CREATE OR REPLACE FUNCTION staging.repair_asset_topology_and_attributes(
  target_uuid UUID,
  radius_meters DOUBLE PRECISION DEFAULT 50,
  p_dry_run BOOLEAN DEFAULT FALSE
)
RETURNS JSONB AS $$
DECLARE
  repairs JSONB := '[]'::JSONB;
  proposed JSONB := '[]'::JSONB;
  applied JSONB := '[]'::JSONB;
  skipped JSONB := '[]'::JSONB;
  deferred_master JSONB := '[]'::JSONB;
  seg RECORD;
  v_node_geom geometry;
  v_is_node BOOLEAN := FALSE;
  v_new_source UUID;
  v_new_target UUID;
  v_near_mrid UUID;
  v_dist_m DOUBLE PRECISION;
  v_action JSONB;
  v_new_geom geometry;
  v_changed BOOLEAN;
  v_src_schema TEXT;
  v_tgt_schema TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM staging.identified_objects WHERE mrid = target_uuid) THEN
    RAISE EXCEPTION 'Staging asset % not found', target_uuid;
  END IF;

  SELECT cn.geom INTO v_node_geom
  FROM staging.connectivity_nodes cn
  WHERE cn.mrid = target_uuid;
  v_is_node := FOUND;

  -- Staging line segments near the target (or the target line itself).
  FOR seg IN
    SELECT DISTINCT ON (als.mrid)
      als.mrid,
      als.source_node_id,
      als.target_node_id,
      als.geom,
      'staging'::text AS segment_tier
    FROM staging.ac_line_segments als
    WHERE (
      v_is_node
      AND (
        ST_DWithin(ST_StartPoint(als.geom)::geography, v_node_geom::geography, radius_meters)
        OR ST_DWithin(ST_EndPoint(als.geom)::geography, v_node_geom::geography, radius_meters)
        OR als.source_node_id = target_uuid
        OR als.target_node_id = target_uuid
      )
    )
    OR als.mrid = target_uuid
    ORDER BY als.mrid
  LOOP
    v_new_source := seg.source_node_id;
    v_new_target := seg.target_node_id;
    v_action := jsonb_build_object('segment_mrid', seg.mrid, 'segment_tier', seg.segment_tier);
    v_changed := FALSE;
    v_src_schema := 'staging';
    v_tgt_schema := 'staging';

    IF v_is_node
       AND ST_DWithin(ST_StartPoint(seg.geom)::geography, v_node_geom::geography, radius_meters)
       AND v_new_target IS DISTINCT FROM target_uuid
    THEN
      v_dist_m := ST_Distance(ST_StartPoint(seg.geom)::geography, v_node_geom::geography);
      IF v_new_source IS DISTINCT FROM target_uuid THEN
        v_new_source := target_uuid;
        v_action := v_action || jsonb_build_object(
          'link_start_to', target_uuid, 'start_dist_m', round(v_dist_m::numeric, 2)
        );
        v_changed := TRUE;
      END IF;
    ELSE
      SELECT cn.mrid,
             ST_Distance(ST_StartPoint(seg.geom)::geography, cn.geom::geography)
      INTO v_near_mrid, v_dist_m
      FROM staging.connectivity_nodes cn
      WHERE cn.mrid IS DISTINCT FROM seg.target_node_id
      ORDER BY cn.geom <-> ST_StartPoint(seg.geom)
      LIMIT 1;
      IF v_near_mrid IS NOT NULL
         AND v_dist_m <= radius_meters
         AND v_new_source IS DISTINCT FROM v_near_mrid
      THEN
        v_new_source := v_near_mrid;
        v_action := v_action || jsonb_build_object(
          'link_start_to', v_near_mrid, 'start_dist_m', round(v_dist_m::numeric, 2)
        );
        v_changed := TRUE;
      END IF;
    END IF;

    IF v_is_node
       AND ST_DWithin(ST_EndPoint(seg.geom)::geography, v_node_geom::geography, radius_meters)
       AND v_new_source IS DISTINCT FROM target_uuid
    THEN
      v_dist_m := ST_Distance(ST_EndPoint(seg.geom)::geography, v_node_geom::geography);
      IF v_new_target IS DISTINCT FROM target_uuid THEN
        v_new_target := target_uuid;
        v_action := v_action || jsonb_build_object(
          'link_end_to', target_uuid, 'end_dist_m', round(v_dist_m::numeric, 2)
        );
        v_changed := TRUE;
      END IF;
    ELSE
      SELECT cn.mrid,
             ST_Distance(ST_EndPoint(seg.geom)::geography, cn.geom::geography)
      INTO v_near_mrid, v_dist_m
      FROM staging.connectivity_nodes cn
      WHERE cn.mrid IS DISTINCT FROM v_new_source
      ORDER BY cn.geom <-> ST_EndPoint(seg.geom)
      LIMIT 1;
      IF v_near_mrid IS NOT NULL
         AND v_dist_m <= radius_meters
         AND v_new_target IS DISTINCT FROM v_near_mrid
      THEN
        v_new_target := v_near_mrid;
        v_action := v_action || jsonb_build_object(
          'link_end_to', v_near_mrid, 'end_dist_m', round(v_dist_m::numeric, 2)
        );
        v_changed := TRUE;
      END IF;
    END IF;

    IF v_new_source IS NOT NULL AND v_new_target IS NOT NULL AND v_new_source = v_new_target THEN
      skipped := skipped || jsonb_build_array(v_action || jsonb_build_object('reason', 'self_loop'));
      CONTINUE;
    END IF;

    IF v_new_source IS NOT NULL AND v_new_target IS NOT NULL THEN
      SELECT ST_SetSRID(ST_MakeLine(src.geom, tgt.geom), 4326)
      INTO v_new_geom
      FROM staging.connectivity_nodes src
      JOIN staging.connectivity_nodes tgt ON tgt.mrid = v_new_target
      WHERE src.mrid = v_new_source;

      IF v_new_geom IS NOT NULL AND v_changed THEN
        v_action := v_action || jsonb_build_object(
          'source_node_id', v_new_source,
          'target_node_id', v_new_target,
          'geom_snapped', TRUE,
          'geom_before', ST_AsGeoJSON(seg.geom)::jsonb,
          'geom_after', ST_AsGeoJSON(v_new_geom)::jsonb
        );
        IF p_dry_run THEN
          proposed := proposed || jsonb_build_array(v_action);
        ELSE
          UPDATE staging.ac_line_segments
          SET source_node_id = v_new_source,
              target_node_id = v_new_target,
              geom = v_new_geom
          WHERE mrid = seg.mrid;
          IF FOUND THEN
            applied := applied || jsonb_build_array(v_action);
            repairs := repairs || jsonb_build_array(v_action);
          END IF;
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- Master network segments near a staging node (preview; defer master writes until promote).
  IF v_is_node AND v_node_geom IS NOT NULL THEN
    FOR seg IN
      SELECT DISTINCT ON (als.mrid)
        als.mrid,
        als.source_node_id,
        als.target_node_id,
        als.geom,
        'master'::text AS segment_tier
      FROM public.ac_line_segments als
      WHERE ST_DWithin(ST_StartPoint(als.geom)::geography, v_node_geom::geography, radius_meters)
         OR ST_DWithin(ST_EndPoint(als.geom)::geography, v_node_geom::geography, radius_meters)
      ORDER BY als.mrid
    LOOP
      v_new_source := seg.source_node_id;
      v_new_target := seg.target_node_id;
      v_action := jsonb_build_object('segment_mrid', seg.mrid, 'segment_tier', 'master');
      v_changed := FALSE;

      IF ST_DWithin(ST_StartPoint(seg.geom)::geography, v_node_geom::geography, radius_meters)
         AND v_new_target IS DISTINCT FROM target_uuid
      THEN
        v_dist_m := ST_Distance(ST_StartPoint(seg.geom)::geography, v_node_geom::geography);
        IF v_new_source IS DISTINCT FROM target_uuid THEN
          v_new_source := target_uuid;
          v_action := v_action || jsonb_build_object(
            'link_start_to', target_uuid, 'start_dist_m', round(v_dist_m::numeric, 2)
          );
          v_changed := TRUE;
        END IF;
      END IF;

      IF ST_DWithin(ST_EndPoint(seg.geom)::geography, v_node_geom::geography, radius_meters)
         AND v_new_source IS DISTINCT FROM target_uuid
      THEN
        v_dist_m := ST_Distance(ST_EndPoint(seg.geom)::geography, v_node_geom::geography);
        IF v_new_target IS DISTINCT FROM target_uuid THEN
          v_new_target := target_uuid;
          v_action := v_action || jsonb_build_object(
            'link_end_to', target_uuid, 'end_dist_m', round(v_dist_m::numeric, 2)
          );
          v_changed := TRUE;
        END IF;
      END IF;

      IF NOT v_changed OR v_new_source = v_new_target THEN
        CONTINUE;
      END IF;

      SELECT ST_SetSRID(ST_MakeLine(src.geom, tgt.geom), 4326)
      INTO v_new_geom
      FROM (
        SELECT COALESCE((SELECT geom FROM staging.connectivity_nodes WHERE mrid = v_new_source), (SELECT geom FROM public.connectivity_nodes WHERE mrid = v_new_source)) AS geom
      ) src
      CROSS JOIN (
        SELECT COALESCE((SELECT geom FROM staging.connectivity_nodes WHERE mrid = v_new_target), (SELECT geom FROM public.connectivity_nodes WHERE mrid = v_new_target)) AS geom
      ) tgt
      WHERE src.geom IS NOT NULL AND tgt.geom IS NOT NULL;

      IF v_new_geom IS NULL THEN
        skipped := skipped || jsonb_build_array(v_action || jsonb_build_object('reason', 'missing_node_geom'));
        CONTINUE;
      END IF;

      v_action := v_action || jsonb_build_object(
        'source_node_id', v_new_source,
        'target_node_id', v_new_target,
        'geom_snapped', TRUE,
        'geom_before', ST_AsGeoJSON(seg.geom)::jsonb,
        'geom_after', ST_AsGeoJSON(v_new_geom)::jsonb,
        'deferred_until_promote', TRUE
      );

      IF p_dry_run THEN
        proposed := proposed || jsonb_build_array(v_action);
      ELSE
        deferred_master := deferred_master || jsonb_build_array(v_action);
        applied := applied || jsonb_build_array(v_action);
      END IF;
    END LOOP;
  END IF;

  IF NOT p_dry_run THEN
    UPDATE staging.identified_objects
    SET validation = 'STAGED',
        repair_proposals = deferred_master,
        updated_at = NOW()
    WHERE mrid = target_uuid
      AND validation IN ('PENDING_FIELD', 'STAGED', 'IN_CONFLICT');
  END IF;

  RETURN jsonb_build_object(
    'target_mrid', target_uuid,
    'tier', 'staging',
    'dry_run', p_dry_run,
    'target_kind', CASE
      WHEN v_is_node THEN 'connectivity_node'
      WHEN EXISTS (SELECT 1 FROM staging.ac_line_segments WHERE mrid = target_uuid) THEN 'ac_line_segment'
      ELSE 'field_capture'
    END,
    'repairs', repairs,
    'proposed', proposed,
    'applied', applied,
    'skipped', skipped,
    'deferred_master', deferred_master,
    'radius_meters', radius_meters
  );
END;
$$ LANGUAGE plpgsql;

-- Apply queued master segment repairs after a staging node is promoted (same MRID).
CREATE OR REPLACE FUNCTION staging.apply_deferred_master_repairs(target_mrid UUID)
RETURNS JSONB AS $$
DECLARE
  v_props JSONB;
  v_item JSONB;
  v_applied JSONB := '[]'::jsonb;
  v_new_source UUID;
  v_new_target UUID;
  v_new_geom geometry;
BEGIN
  SELECT repair_proposals INTO v_props
  FROM staging.identified_objects
  WHERE mrid = target_mrid;

  IF v_props IS NULL OR jsonb_array_length(v_props) = 0 THEN
    RETURN jsonb_build_object('applied', v_applied);
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_props)
  LOOP
    v_new_source := (v_item->>'source_node_id')::uuid;
    v_new_target := (v_item->>'target_node_id')::uuid;
    IF v_new_source IS NULL OR v_new_target IS NULL THEN
      CONTINUE;
    END IF;

    SELECT ST_SetSRID(ST_MakeLine(src.geom, tgt.geom), 4326)
    INTO v_new_geom
    FROM public.connectivity_nodes src
    JOIN public.connectivity_nodes tgt ON tgt.mrid = v_new_target
    WHERE src.mrid = v_new_source;

    IF v_new_geom IS NULL THEN
      CONTINUE;
    END IF;

    UPDATE public.ac_line_segments
    SET source_node_id = v_new_source,
        target_node_id = v_new_target,
        geom = v_new_geom
    WHERE mrid = (v_item->>'segment_mrid')::uuid;

    IF FOUND THEN
      v_applied := v_applied || jsonb_build_array(v_item);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('applied', v_applied);
END;
$$ LANGUAGE plpgsql;

-- Back-compat wrapper (old 2-arg calls).
CREATE OR REPLACE FUNCTION repair_staging_asset_topology_and_attributes(
  target_uuid UUID,
  radius_meters DOUBLE PRECISION DEFAULT 50
)
RETURNS JSONB AS $$
  SELECT staging.repair_asset_topology_and_attributes(target_uuid, radius_meters, FALSE);
$$ LANGUAGE sql;

GRANT EXECUTE ON FUNCTION staging.repair_asset_topology_and_attributes(UUID, DOUBLE PRECISION, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION staging.apply_deferred_master_repairs(UUID) TO service_role;

-- Apply deferred master line snaps when a staging node is promoted.
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
