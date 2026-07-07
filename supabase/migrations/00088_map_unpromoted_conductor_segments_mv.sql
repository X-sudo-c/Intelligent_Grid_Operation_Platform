-- Materialized map gap layer: precompute unpromoted GIS lines for fast Martin tiles.

DROP VIEW IF EXISTS public.map_unpromoted_conductor_segments;

CREATE MATERIALIZED VIEW public.map_unpromoted_conductor_segments AS
WITH line AS (
  SELECT
    cs.id,
    cs.source_layer,
    cs.source_fid,
    cs.district,
    cs.voltage_class,
    gis.as_linestring(cs.geom)::geometry(LineString, 4326) AS geom
  FROM gis.conductor_segments cs
  WHERE cs.geom IS NOT NULL
)
SELECT
  l.id,
  l.source_layer,
  CASE l.voltage_class
    WHEN 'MV_11KV' THEN 'MV_11KV'
    WHEN 'MV_33KV' THEN 'MV_33KV'
    WHEN 'LV' THEN 'LV_400V'
    ELSE 'MV_11KV'
  END AS nominal_voltage,
  l.district,
  CASE
    WHEN l.source_layer LIKE 'ug\_%' ESCAPE '\' THEN 'UNDERGROUND'
    ELSE 'OVERHEAD'
  END AS installation_type,
  l.geom,
  ST_Length(l.geom::geography) AS length_m
FROM line l
WHERE l.geom IS NOT NULL
  AND ST_Length(l.geom::geography) <= 50000
  AND NOT EXISTS (
    SELECT 1
    FROM public.ac_line_segments als
    WHERE als.mrid = gis.conductor_segment_mrid(l.source_layer, l.source_fid)
  )
WITH NO DATA;

CREATE UNIQUE INDEX idx_map_unpromoted_conductor_segments_id
  ON public.map_unpromoted_conductor_segments (id);

CREATE INDEX idx_map_unpromoted_conductor_segments_geom
  ON public.map_unpromoted_conductor_segments USING GIST (geom);

COMMENT ON MATERIALIZED VIEW public.map_unpromoted_conductor_segments IS
  'Martin map layer (materialized): GIS lines with no ac_line_segments row. Refresh after promote.';

GRANT SELECT ON public.map_unpromoted_conductor_segments TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.refresh_map_unpromoted_conductor_segments(
  p_concurrent BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, gis
AS $$
DECLARE
  n BIGINT;
  t0 TIMESTAMPTZ := clock_timestamp();
  v_populated BOOLEAN;
BEGIN
  SELECT c.relispopulated
  INTO v_populated
  FROM pg_class c
  JOIN pg_namespace nsp ON nsp.oid = c.relnamespace
  WHERE nsp.nspname = 'public'
    AND c.relname = 'map_unpromoted_conductor_segments'
    AND c.relkind = 'm';

  IF COALESCE(v_populated, FALSE) = FALSE OR NOT p_concurrent THEN
    REFRESH MATERIALIZED VIEW public.map_unpromoted_conductor_segments;
  ELSE
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.map_unpromoted_conductor_segments;
  END IF;

  ANALYZE public.map_unpromoted_conductor_segments;
  SELECT COUNT(*) INTO n FROM public.map_unpromoted_conductor_segments;

  RETURN jsonb_build_object(
    'segments', n,
    'concurrent', p_concurrent AND COALESCE(v_populated, FALSE),
    'duration_ms', (EXTRACT(EPOCH FROM (clock_timestamp() - t0)) * 1000)::int
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_map_unpromoted_conductor_segments(BOOLEAN) TO service_role;

-- District promote: refresh gap tiles after lines move to master.
CREATE OR REPLACE FUNCTION gis.promote_conductors_for_district(p_district TEXT)
RETURNS JSONB AS $$
DECLARE
  v_lines BIGINT;
  v_district TEXT := NULLIF(btrim(p_district), '');
  v_gap JSONB;
BEGIN
  IF v_district IS NULL THEN
    RAISE EXCEPTION 'p_district is required';
  END IF;

  DROP TABLE IF EXISTS _gis_eligible_conductors;
  ALTER TABLE public.ac_line_segments DISABLE TRIGGER trg_webhook_ac_line_segments;

  CREATE TEMP TABLE _gis_eligible_conductors ON COMMIT DROP AS
  SELECT
    cs.id,
    cs.source_layer,
    cs.source_fid,
    cs.voltage_class,
    cs.circuit_id,
    gis.conductor_segment_mrid(cs.source_layer, cs.source_fid) AS line_mrid,
    src.mrid AS source_mrid,
    tgt.mrid AS target_mrid,
    gis.as_linestring(cs.geom) AS line_geom
  FROM gis.conductor_segments cs
  JOIN gis.unique_id_lookup src
    ON src.unique_id = btrim(cs.originating_node_id)
  JOIN gis.unique_id_lookup tgt
    ON tgt.unique_id = btrim(cs.end_node_id)
  WHERE btrim(cs.district) = v_district
    AND cs.originating_node_id IS NOT NULL
    AND cs.end_node_id IS NOT NULL
    AND btrim(cs.originating_node_id) <> ''
    AND btrim(cs.end_node_id) <> ''
    AND src.mrid IS DISTINCT FROM tgt.mrid
    AND gis.as_linestring(cs.geom) IS NOT NULL
    AND ST_Distance(src.geom::geography, tgt.geom::geography)
        <= gis.max_conductor_snap_span_m(cs.voltage_class)
    AND ST_Length(gis.as_linestring(cs.geom)::geography)
        <= gis.max_conductor_snap_span_m(cs.voltage_class);

  INSERT INTO public.identified_objects (mrid, name, lifecycle_state, validation)
  SELECT
    e.line_mrid,
    e.source_layer || ' segment ' || e.source_fid::text,
    'IN_SERVICE',
    'APPROVED'
  FROM _gis_eligible_conductors e
  ON CONFLICT (mrid) DO NOTHING;

  INSERT INTO public.conducting_equipment (mrid, phases, nominal_voltage, serial_number)
  SELECT
    e.line_mrid,
    'ABC',
    gis.voltage_class_to_enum(e.voltage_class),
    NULLIF(btrim(e.circuit_id), '')
  FROM _gis_eligible_conductors e
  ON CONFLICT (mrid) DO NOTHING;

  INSERT INTO public.ac_line_segments (
    mrid, source_node_id, target_node_id, direction_downstream, geom
  )
  SELECT
    e.line_mrid,
    e.source_mrid,
    e.target_mrid,
    TRUE,
    e.line_geom::geometry(LineString, 4326)
  FROM _gis_eligible_conductors e
  WHERE GeometryType(e.line_geom) = 'LINESTRING'
  ON CONFLICT (mrid) DO UPDATE SET
    source_node_id = EXCLUDED.source_node_id,
    target_node_id = EXCLUDED.target_node_id,
    geom = EXCLUDED.geom;

  GET DIAGNOSTICS v_lines = ROW_COUNT;
  ALTER TABLE public.ac_line_segments ENABLE TRIGGER trg_webhook_ac_line_segments;

  v_gap := public.refresh_map_unpromoted_conductor_segments(TRUE);

  RETURN jsonb_build_object(
    'district', v_district,
    'ac_line_segments_upserted', v_lines,
    'map_unpromoted_gap', v_gap
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION gis.promote_topology_to_cim()
RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'unique_id_lookup', gis.rebuild_unique_id_lookup(),
    'support_structures', gis.promote_support_structures_to_cim(),
    'endpoint_infer_tier_a', gis.infer_conductor_endpoint_ids_tier_a(5.0::double precision, NULL::text),
    'conductor_snap', gis.snap_eligible_conductor_endpoints(),
    'conductors', gis.promote_conductors_to_cim(),
    'import_status', gis.refresh_conductor_import_status(),
    'connected_nodes', public.refresh_connected_node_mrids(),
    'map_unpromoted_gap', public.refresh_map_unpromoted_conductor_segments(FALSE)
  );
$$ LANGUAGE sql;
