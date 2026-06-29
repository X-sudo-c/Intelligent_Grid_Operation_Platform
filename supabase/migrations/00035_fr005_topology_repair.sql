-- FR-005: topology repair — link loose endpoints, update FKs, snap both ends.

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
  -- Pass 1: normalize conducting equipment serial numbers when target is CE.
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
    v_action := jsonb_build_object('segment_mrid', seg.mrid);
    v_changed := FALSE;

    -- Start endpoint: prefer explicit link to target node when within radius.
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

    -- End endpoint: prefer explicit link to target node when within radius.
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

    -- Rebuild geometry from resolved node coordinates when FKs changed or geom is loose.
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
          'geom_snapped', TRUE
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

COMMENT ON FUNCTION public.repair_asset_topology_and_attributes(UUID, DOUBLE PRECISION, BOOLEAN) IS
  'FR-005 dual-pass repair: attribute normalize + link/snap line endpoints to connectivity nodes within radius.';
