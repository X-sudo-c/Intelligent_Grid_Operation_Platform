-- Steward-reviewed GIS endpoint fix proposals (geometry → from/to pole IDs).
-- Generate proposals without mutating conductor_segments; apply only after approval.

CREATE TABLE IF NOT EXISTS gis.conductor_endpoint_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id BIGINT NOT NULL REFERENCES gis.conductor_segments (id) ON DELETE CASCADE,
  district TEXT,
  source_layer TEXT,
  source_fid BIGINT,
  import_reason TEXT,
  current_from TEXT,
  current_to TEXT,
  proposed_from TEXT NOT NULL,
  proposed_to TEXT NOT NULL,
  start_dist_m DOUBLE PRECISION,
  end_dist_m DOUBLE PRECISION,
  start_nearest_pole TEXT,
  end_nearest_pole TEXT,
  tier TEXT NOT NULL CHECK (tier IN ('tier_a', 'tier_b')),
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'applied')),
  batch_id UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  applied_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_gis_endpoint_proposals_segment_open
  ON gis.conductor_endpoint_proposals (segment_id)
  WHERE status IN ('pending', 'approved');

CREATE INDEX IF NOT EXISTS idx_gis_endpoint_proposals_status_district
  ON gis.conductor_endpoint_proposals (status, district, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gis_endpoint_proposals_batch
  ON gis.conductor_endpoint_proposals (batch_id);

COMMENT ON TABLE gis.conductor_endpoint_proposals IS
  'Steward review queue: proposed originating_node_id / end_node_id from geometry + nearest poles.';

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
      SELECT COUNT(*)::bigint
      FROM gis.conductor_endpoint_proposals
      WHERE district = v_district AND status = 'pending'
    ),
    'tier_a_pending', (
      SELECT COUNT(*)::bigint
      FROM gis.conductor_endpoint_proposals
      WHERE district = v_district AND status = 'pending' AND tier = 'tier_a'
    ),
    'tier_b_pending', (
      SELECT COUNT(*)::bigint
      FROM gis.conductor_endpoint_proposals
      WHERE district = v_district AND status = 'pending' AND tier = 'tier_b'
    ),
    'tolerance_m', p_tolerance_m,
    'assisted_m', p_assisted_m
  );
END;
$$;

CREATE OR REPLACE FUNCTION gis.apply_endpoint_fix_proposals(
  p_proposal_ids UUID[] DEFAULT NULL,
  p_district TEXT DEFAULT NULL,
  p_operator TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = gis, public
AS $$
DECLARE
  v_district TEXT := NULLIF(btrim(p_district), '');
  v_applied BIGINT := 0;
BEGIN
  WITH to_apply AS (
    SELECT p.id, p.segment_id, p.proposed_from, p.proposed_to
    FROM gis.conductor_endpoint_proposals p
    WHERE p.status = 'approved'
      AND (p_proposal_ids IS NULL OR p.id = ANY(p_proposal_ids))
      AND (v_district IS NULL OR p.district = v_district)
  ),
  updated AS (
    UPDATE gis.conductor_segments cs
    SET
      originating_node_id = t.proposed_from,
      end_node_id = t.proposed_to
    FROM to_apply t
    WHERE cs.id = t.segment_id
    RETURNING cs.id
  ),
  marked AS (
    UPDATE gis.conductor_endpoint_proposals p
    SET
      status = 'applied',
      applied_at = now(),
      reviewed_by = COALESCE(p.reviewed_by, p_operator)
    FROM to_apply t
    WHERE p.id = t.id
    RETURNING p.id
  )
  SELECT COUNT(*)::bigint INTO v_applied FROM marked;

  IF v_applied > 0 THEN
    PERFORM gis.refresh_conductor_import_status();
  END IF;

  RETURN jsonb_build_object(
    'applied', v_applied,
    'operator', p_operator,
    'district', v_district
  );
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON gis.conductor_endpoint_proposals TO service_role;
GRANT EXECUTE ON FUNCTION gis.generate_endpoint_fix_proposals(TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, BOOLEAN, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION gis.apply_endpoint_fix_proposals(UUID[], TEXT, TEXT) TO service_role;
