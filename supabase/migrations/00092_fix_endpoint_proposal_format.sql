-- Fix PostgreSQL format() in generate_endpoint_fix_proposals (%.1f is not valid in format()).

CREATE OR REPLACE FUNCTION gis.generate_endpoint_fix_proposals(
  p_district TEXT,
  p_tolerance_m DOUBLE PRECISION DEFAULT 5.0,
  p_assisted_m DOUBLE PRECISION DEFAULT 15.0,
  p_limit INTEGER DEFAULT 5000,
  p_include_tier_b BOOLEAN DEFAULT TRUE,
  p_replace_pending BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = gis, public
AS $$
DECLARE
  v_district TEXT := NULLIF(btrim(p_district), '');
  v_batch UUID := gen_random_uuid();
  v_inserted BIGINT := 0;
BEGIN
  IF v_district IS NULL THEN
    RAISE EXCEPTION 'district is required';
  END IF;
  IF p_tolerance_m IS NULL OR p_tolerance_m <= 0 OR p_tolerance_m > 50 THEN
    RAISE EXCEPTION 'p_tolerance_m must be between 0 and 50';
  END IF;
  IF p_assisted_m IS NULL OR p_assisted_m < p_tolerance_m OR p_assisted_m > 100 THEN
    RAISE EXCEPTION 'p_assisted_m must be between tolerance and 100';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50000 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 50000';
  END IF;

  IF p_replace_pending THEN
    DELETE FROM gis.conductor_endpoint_proposals
    WHERE district = v_district AND status = 'pending';
  END IF;

  WITH unpromoted AS (
    SELECT
      cs.id,
      cs.source_layer,
      cs.source_fid,
      btrim(cs.district) AS district,
      s.reason AS import_reason,
      NULLIF(btrim(cs.originating_node_id), '') AS current_from,
      NULLIF(btrim(cs.end_node_id), '') AS current_to,
      gis.as_linestring(cs.geom) AS line_geom,
      src_l.unique_id IS NOT NULL AS start_ok,
      tgt_l.unique_id IS NOT NULL AS end_ok
    FROM gis.conductor_import_status s
    JOIN gis.conductor_segments cs ON cs.id = s.id
    LEFT JOIN gis.unique_id_lookup src_l
      ON src_l.unique_id = btrim(cs.originating_node_id)
    LEFT JOIN gis.unique_id_lookup tgt_l
      ON tgt_l.unique_id = btrim(cs.end_node_id)
    WHERE s.reason <> 'already_promoted'
      AND btrim(cs.district) = v_district
      AND cs.geom IS NOT NULL
      AND gis.as_linestring(cs.geom) IS NOT NULL
  ),
  nearest AS (
    SELECT
      u.*,
      ns.pole_id AS start_nearest,
      ns.dist_m AS start_dist_m,
      ne.pole_id AS end_nearest,
      ne.dist_m AS end_dist_m
    FROM unpromoted u
    LEFT JOIN LATERAL (
      SELECT am.source_unique_id AS pole_id,
             ST_Distance(ST_StartPoint(u.line_geom)::geography, am.geom::geography) AS dist_m
      FROM gis.asset_id_map am
      WHERE am.source_layer LIKE 'oh_support_structure%'
        AND am.geom IS NOT NULL
        AND am.source_unique_id IS NOT NULL
        AND btrim(am.source_unique_id) <> ''
      ORDER BY am.geom <-> ST_StartPoint(u.line_geom)
      LIMIT 1
    ) ns ON TRUE
    LEFT JOIN LATERAL (
      SELECT am.source_unique_id AS pole_id,
             ST_Distance(ST_EndPoint(u.line_geom)::geography, am.geom::geography) AS dist_m
      FROM gis.asset_id_map am
      WHERE am.source_layer LIKE 'oh_support_structure%'
        AND am.geom IS NOT NULL
        AND am.source_unique_id IS NOT NULL
        AND btrim(am.source_unique_id) <> ''
      ORDER BY am.geom <-> ST_EndPoint(u.line_geom)
      LIMIT 1
    ) ne ON TRUE
  ),
  resolved AS (
    SELECT
      n.*,
      CASE
        WHEN n.start_ok THEN n.current_from
        WHEN gis.is_customer_equipment_id(btrim(COALESCE(n.current_from, ''))) THEN NULL
        WHEN gis.classify_endpoint_id(btrim(COALESCE(n.current_from, ''))) = 'generic_short_id' THEN NULL
        WHEN n.start_nearest IS NOT NULL AND n.start_dist_m <= p_tolerance_m THEN n.start_nearest
        WHEN p_include_tier_b AND n.start_nearest IS NOT NULL AND n.start_dist_m <= p_assisted_m THEN n.start_nearest
        ELSE NULL
      END AS prop_from,
      CASE
        WHEN n.end_ok THEN n.current_to
        WHEN gis.is_customer_equipment_id(btrim(COALESCE(n.current_to, ''))) THEN NULL
        WHEN gis.classify_endpoint_id(btrim(COALESCE(n.current_to, ''))) = 'generic_short_id' THEN NULL
        WHEN n.end_nearest IS NOT NULL AND n.end_dist_m <= p_tolerance_m THEN n.end_nearest
        WHEN p_include_tier_b AND n.end_nearest IS NOT NULL AND n.end_dist_m <= p_assisted_m THEN n.end_nearest
        ELSE NULL
      END AS prop_to,
      CASE
        WHEN (n.start_ok OR (n.start_dist_m IS NOT NULL AND n.start_dist_m <= p_tolerance_m))
         AND (n.end_ok OR (n.end_dist_m IS NOT NULL AND n.end_dist_m <= p_tolerance_m))
         AND NOT gis.is_customer_equipment_id(btrim(COALESCE(n.current_from, '')))
         AND NOT gis.is_customer_equipment_id(btrim(COALESCE(n.current_to, '')))
        THEN 'tier_a'
        WHEN p_include_tier_b
         AND (
           (NOT n.start_ok AND n.start_dist_m IS NOT NULL AND n.start_dist_m <= p_assisted_m)
           OR (NOT n.end_ok AND n.end_dist_m IS NOT NULL AND n.end_dist_m <= p_assisted_m)
         )
         AND NOT gis.is_customer_equipment_id(btrim(COALESCE(n.current_from, '')))
         AND NOT gis.is_customer_equipment_id(btrim(COALESCE(n.current_to, '')))
        THEN 'tier_b'
        ELSE NULL
      END AS tier
    FROM nearest n
  ),
  candidates AS (
    SELECT
      r.id AS segment_id,
      r.district,
      r.source_layer,
      r.source_fid,
      r.import_reason,
      r.current_from,
      r.current_to,
      r.prop_from AS proposed_from,
      r.prop_to AS proposed_to,
      r.start_dist_m,
      r.end_dist_m,
      r.start_nearest AS start_nearest_pole,
      r.end_nearest AS end_nearest_pole,
      r.tier,
      CASE
        WHEN r.tier = 'tier_a' THEN
          format(
            'Both endpoints resolvable within %s m — geometry snap to nearest poles.',
            round(p_tolerance_m::numeric, 1)
          )
        WHEN r.tier = 'tier_b' THEN
          format(
            'Assisted fix within %s m — review nearest-pole match before approve.',
            round(p_assisted_m::numeric, 1)
          )
        ELSE NULL
      END AS rationale
    FROM resolved r
    WHERE r.tier IS NOT NULL
      AND r.prop_from IS NOT NULL
      AND r.prop_to IS NOT NULL
      AND r.prop_from IS DISTINCT FROM r.prop_to
      AND (
        r.prop_from IS DISTINCT FROM r.current_from
        OR r.prop_to IS DISTINCT FROM r.current_to
      )
    ORDER BY
      CASE r.tier WHEN 'tier_a' THEN 0 ELSE 1 END,
      LEAST(COALESCE(r.start_dist_m, 9999), COALESCE(r.end_dist_m, 9999))
    LIMIT p_limit
  ),
  ins AS (
    INSERT INTO gis.conductor_endpoint_proposals (
      segment_id,
      district,
      source_layer,
      source_fid,
      import_reason,
      current_from,
      current_to,
      proposed_from,
      proposed_to,
      start_dist_m,
      end_dist_m,
      start_nearest_pole,
      end_nearest_pole,
      tier,
      rationale,
      status,
      batch_id
    )
    SELECT
      c.segment_id,
      c.district,
      c.source_layer,
      c.source_fid,
      c.import_reason,
      c.current_from,
      c.current_to,
      c.proposed_from,
      c.proposed_to,
      c.start_dist_m,
      c.end_dist_m,
      c.start_nearest_pole,
      c.end_nearest_pole,
      c.tier,
      c.rationale,
      'pending',
      v_batch
    FROM candidates c
    WHERE NOT EXISTS (
      SELECT 1
      FROM gis.conductor_endpoint_proposals p
      WHERE p.segment_id = c.segment_id
        AND p.status IN ('pending', 'approved')
    )
    RETURNING 1
  )
  SELECT COUNT(*)::bigint INTO v_inserted FROM ins;

  RETURN jsonb_build_object(
    'batch_id', v_batch,
    'district', v_district,
    'inserted', v_inserted,
    'pending_total', (
      SELECT COUNT(*)::bigint FROM gis.conductor_endpoint_proposals
      WHERE district = v_district AND status = 'pending'
    ),
    'tier_a_pending', (
      SELECT COUNT(*)::bigint FROM gis.conductor_endpoint_proposals
      WHERE district = v_district AND status = 'pending' AND tier = 'tier_a'
    ),
    'tier_b_pending', (
      SELECT COUNT(*)::bigint FROM gis.conductor_endpoint_proposals
      WHERE district = v_district AND status = 'pending' AND tier = 'tier_b'
    ),
    'tolerance_m', p_tolerance_m,
    'assisted_m', p_assisted_m
  );
END;
$$;
