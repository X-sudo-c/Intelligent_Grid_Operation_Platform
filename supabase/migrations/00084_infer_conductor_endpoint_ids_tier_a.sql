-- Tier A: infer conductor endpoint text IDs from nearest pole geometry (conservative).
-- Targets unpromoted segments where line ends land on a support structure within tolerance
-- but originating_node_id / end_node_id text fails lookup (typo, blank, alias gap).

-- Idempotent: 00085 replaces this with a district-scoped 2-arg overload.
DROP FUNCTION IF EXISTS gis.infer_conductor_endpoint_ids_tier_a(DOUBLE PRECISION, TEXT);
DROP FUNCTION IF EXISTS gis.infer_conductor_endpoint_ids_tier_a(DOUBLE PRECISION);

CREATE OR REPLACE FUNCTION gis.infer_conductor_endpoint_ids_tier_a(
  p_tolerance_m DOUBLE PRECISION DEFAULT 5.0
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = gis, public
AS $$
DECLARE
  v_start_inferred BIGINT := 0;
  v_end_inferred BIGINT := 0;
  v_rows_touched BIGINT := 0;
BEGIN
  IF p_tolerance_m IS NULL OR p_tolerance_m <= 0 OR p_tolerance_m > 50 THEN
    RAISE EXCEPTION 'p_tolerance_m must be between 0 and 50 (got %)', p_tolerance_m;
  END IF;

  DROP TABLE IF EXISTS _tier_a_endpoint_infer;
  CREATE TEMP TABLE _tier_a_endpoint_infer ON COMMIT DROP AS
  WITH candidates AS (
    SELECT
      cs.id,
      cs.originating_node_id,
      cs.end_node_id,
      gis.as_linestring(cs.geom) AS line_geom,
      src_l.unique_id IS NOT NULL AS start_ok,
      tgt_l.unique_id IS NOT NULL AS end_ok
    FROM gis.conductor_segments cs
    LEFT JOIN gis.unique_id_lookup src_l
      ON src_l.unique_id = btrim(cs.originating_node_id)
    LEFT JOIN gis.unique_id_lookup tgt_l
      ON tgt_l.unique_id = btrim(cs.end_node_id)
    WHERE cs.geom IS NOT NULL
      AND gis.as_linestring(cs.geom) IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.ac_line_segments als
        WHERE als.mrid = gis.conductor_segment_mrid(cs.source_layer, cs.source_fid)
      )
  ),
  with_start AS (
    SELECT
      c.*,
      CASE
        WHEN c.start_ok THEN NULLIF(btrim(c.originating_node_id), '')
        WHEN gis.is_customer_equipment_id(btrim(COALESCE(c.originating_node_id, ''))) THEN NULL
        WHEN gis.classify_endpoint_id(btrim(COALESCE(c.originating_node_id, ''))) = 'generic_short_id' THEN NULL
        WHEN ns.source_unique_id IS NULL THEN NULL
        WHEN ns.dist_m > p_tolerance_m THEN NULL
        ELSE ns.source_unique_id
      END AS new_orig
    FROM candidates c
    LEFT JOIN LATERAL (
      SELECT
        am.source_unique_id,
        ST_Distance(ST_StartPoint(c.line_geom)::geography, am.geom::geography) AS dist_m
      FROM gis.asset_id_map am
      WHERE am.source_layer LIKE 'oh_support_structure%'
        AND am.geom IS NOT NULL
        AND am.source_unique_id IS NOT NULL
        AND btrim(am.source_unique_id) <> ''
      ORDER BY am.geom <-> ST_StartPoint(c.line_geom)
      LIMIT 1
    ) ns ON TRUE
  ),
  with_both AS (
    SELECT
      ws.id,
      ws.originating_node_id,
      ws.end_node_id,
      ws.start_ok,
      ws.end_ok,
      ws.new_orig,
      CASE
        WHEN ws.end_ok THEN NULLIF(btrim(ws.end_node_id), '')
        WHEN gis.is_customer_equipment_id(btrim(COALESCE(ws.end_node_id, ''))) THEN NULL
        WHEN gis.classify_endpoint_id(btrim(COALESCE(ws.end_node_id, ''))) = 'generic_short_id' THEN NULL
        WHEN ne.source_unique_id IS NULL THEN NULL
        WHEN ne.dist_m > p_tolerance_m THEN NULL
        ELSE ne.source_unique_id
      END AS new_end
    FROM with_start ws
    LEFT JOIN LATERAL (
      SELECT
        am.source_unique_id,
        ST_Distance(ST_EndPoint(ws.line_geom)::geography, am.geom::geography) AS dist_m
      FROM gis.asset_id_map am
      WHERE am.source_layer LIKE 'oh_support_structure%'
        AND am.geom IS NOT NULL
        AND am.source_unique_id IS NOT NULL
        AND btrim(am.source_unique_id) <> ''
      ORDER BY am.geom <-> ST_EndPoint(ws.line_geom)
      LIMIT 1
    ) ne ON TRUE
  )
  SELECT
    wb.id,
    COALESCE(wb.new_orig, NULLIF(btrim(wb.originating_node_id), '')) AS resolved_orig,
    COALESCE(wb.new_end, NULLIF(btrim(wb.end_node_id), '')) AS resolved_end,
    (NOT wb.start_ok AND wb.new_orig IS NOT NULL) AS start_inferred,
    (NOT wb.end_ok AND wb.new_end IS NOT NULL) AS end_inferred
  FROM with_both wb
  WHERE COALESCE(wb.new_orig, NULLIF(btrim(wb.originating_node_id), '')) IS NOT NULL
    AND COALESCE(wb.new_end, NULLIF(btrim(wb.end_node_id), '')) IS NOT NULL
    AND COALESCE(wb.new_orig, NULLIF(btrim(wb.originating_node_id), ''))
        IS DISTINCT FROM COALESCE(wb.new_end, NULLIF(btrim(wb.end_node_id), ''))
    AND (
      (NOT wb.start_ok AND wb.new_orig IS NOT NULL)
      OR (NOT wb.end_ok AND wb.new_end IS NOT NULL)
    );

  UPDATE gis.conductor_segments cs
  SET
    originating_node_id = t.resolved_orig,
    end_node_id = t.resolved_end
  FROM _tier_a_endpoint_infer t
  WHERE cs.id = t.id;

  GET DIAGNOSTICS v_rows_touched = ROW_COUNT;

  SELECT
    COUNT(*) FILTER (WHERE start_inferred),
    COUNT(*) FILTER (WHERE end_inferred)
  INTO v_start_inferred, v_end_inferred
  FROM _tier_a_endpoint_infer;

  RETURN jsonb_build_object(
    'tolerance_m', p_tolerance_m,
    'segments_updated', v_rows_touched,
    'start_ids_inferred', v_start_inferred,
    'end_ids_inferred', v_end_inferred
  );
END;
$$;

COMMENT ON FUNCTION gis.infer_conductor_endpoint_ids_tier_a(DOUBLE PRECISION) IS
  'Tier A steward clean: set conductor endpoint text IDs from nearest oh_support_structure pole when within tolerance and lookup failed.';

GRANT EXECUTE ON FUNCTION gis.infer_conductor_endpoint_ids_tier_a(DOUBLE PRECISION) TO service_role;

-- Run before snap/promote so resolved IDs flow into ac_line_segments.
CREATE OR REPLACE FUNCTION gis.promote_topology_to_cim()
RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'unique_id_lookup', gis.rebuild_unique_id_lookup(),
    'support_structures', gis.promote_support_structures_to_cim(),
    'endpoint_infer_tier_a', gis.infer_conductor_endpoint_ids_tier_a(5.0::double precision),
    'conductor_snap', gis.snap_eligible_conductor_endpoints(),
    'conductors', gis.promote_conductors_to_cim(),
    'import_status', gis.refresh_conductor_import_status(),
    'connected_nodes', public.refresh_connected_node_mrids()
  );
$$ LANGUAGE sql;
