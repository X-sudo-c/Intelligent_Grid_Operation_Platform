-- Staging CIM line endpoint fix proposals + data_tier on district AI runs/scans.

ALTER TABLE gis.endpoint_fix_ai_runs
  ADD COLUMN IF NOT EXISTS data_tier TEXT NOT NULL DEFAULT 'gis'
    CHECK (data_tier IN ('gis', 'staging'));

ALTER TABLE gis.endpoint_fix_ai_scans
  ADD COLUMN IF NOT EXISTS data_tier TEXT NOT NULL DEFAULT 'gis'
    CHECK (data_tier IN ('gis', 'staging'));

CREATE INDEX IF NOT EXISTS idx_endpoint_fix_ai_runs_tier_district_status
  ON gis.endpoint_fix_ai_runs (data_tier, district, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_endpoint_fix_ai_scans_tier_district_created
  ON gis.endpoint_fix_ai_scans (data_tier, district, created_at DESC);

CREATE TABLE IF NOT EXISTS staging.line_endpoint_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_mrid UUID NOT NULL REFERENCES staging.ac_line_segments (mrid) ON DELETE CASCADE,
  district TEXT,
  current_source UUID,
  current_target UUID,
  proposed_source UUID NOT NULL,
  proposed_target UUID NOT NULL,
  start_dist_m DOUBLE PRECISION,
  end_dist_m DOUBLE PRECISION,
  start_nearest UUID,
  end_nearest UUID,
  tier TEXT NOT NULL CHECK (tier IN ('tier_a', 'tier_b')),
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'applied')),
  batch_id UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  applied_at TIMESTAMPTZ,
  ai_rationale TEXT,
  ai_confidence TEXT
    CHECK (ai_confidence IS NULL OR ai_confidence IN ('high', 'medium', 'low')),
  ai_agrees BOOLEAN,
  ai_scan_id UUID,
  ai_claim_token UUID,
  ai_claimed_at TIMESTAMPTZ,
  ai_claim_expires_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_staging_line_endpoint_proposals_open
  ON staging.line_endpoint_proposals (segment_mrid)
  WHERE status IN ('pending', 'approved');

CREATE INDEX IF NOT EXISTS idx_staging_line_endpoint_proposals_status_district
  ON staging.line_endpoint_proposals (status, district, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staging_line_endpoint_proposals_ai_claim_pending
  ON staging.line_endpoint_proposals (district, status)
  WHERE status = 'pending' AND ai_rationale IS NULL;

COMMENT ON TABLE staging.line_endpoint_proposals IS
  'Steward review queue for field-capture line endpoint re-links (source/target connectivity nodes).';

CREATE OR REPLACE FUNCTION staging.generate_line_endpoint_fix_proposals(
  p_district TEXT,
  p_tolerance_m DOUBLE PRECISION DEFAULT 1.0,
  p_assisted_m DOUBLE PRECISION DEFAULT 5.0,
  p_limit INTEGER DEFAULT 5000,
  p_include_tier_b BOOLEAN DEFAULT TRUE,
  p_replace_pending BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = staging, gis, public
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
    DELETE FROM staging.line_endpoint_proposals
    WHERE district = v_district AND status = 'pending';
  END IF;

  WITH candidates AS (
    SELECT
      als.mrid AS segment_mrid,
      v_district AS district,
      als.source_node_id AS current_source,
      als.target_node_id AS current_target,
      als.geom,
      ST_StartPoint(als.geom) AS start_pt,
      ST_EndPoint(als.geom) AS end_pt
    FROM staging.ac_line_segments als
    JOIN staging.identified_objects io ON io.mrid = als.mrid
    JOIN staging.connectivity_nodes src ON src.mrid = als.source_node_id
    JOIN staging.connectivity_nodes tgt ON tgt.mrid = als.target_node_id
    JOIN LATERAL (
      SELECT NULLIF(btrim(b.district::text), '') AS district
      FROM gis.ecg_admin_boundaries b
      WHERE ST_Within(ST_Centroid(als.geom), b.geom)
      ORDER BY ST_Area(b.geom::geography) ASC
      LIMIT 1
    ) terr ON terr.district = v_district
    WHERE io.validation NOT IN ('REJECTED', 'APPROVED')
      AND als.geom IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM staging.line_endpoint_proposals p
        WHERE p.segment_mrid = als.mrid
          AND p.status IN ('pending', 'approved')
      )
  ),
  nearest AS (
    SELECT
      c.*,
      ST_Distance(c.start_pt::geography, src.geom::geography) AS start_assigned_dist,
      ST_Distance(c.end_pt::geography, tgt.geom::geography) AS end_assigned_dist,
      ns.mrid AS start_nearest,
      ns.dist_m AS start_dist_m,
      ne.mrid AS end_nearest,
      ne.dist_m AS end_dist_m
    FROM candidates c
    JOIN staging.connectivity_nodes src ON src.mrid = c.current_source
    JOIN staging.connectivity_nodes tgt ON tgt.mrid = c.current_target
    LEFT JOIN LATERAL (
      SELECT cn.mrid,
             ST_Distance(c.start_pt::geography, cn.geom::geography) AS dist_m
      FROM staging.connectivity_nodes cn
      JOIN staging.identified_objects nio ON nio.mrid = cn.mrid
      WHERE nio.validation NOT IN ('REJECTED', 'APPROVED')
        AND cn.geom IS NOT NULL
      ORDER BY cn.geom <-> c.start_pt
      LIMIT 1
    ) ns ON TRUE
    LEFT JOIN LATERAL (
      SELECT cn.mrid,
             ST_Distance(c.end_pt::geography, cn.geom::geography) AS dist_m
      FROM staging.connectivity_nodes cn
      JOIN staging.identified_objects nio ON nio.mrid = cn.mrid
      WHERE nio.validation NOT IN ('REJECTED', 'APPROVED')
        AND cn.geom IS NOT NULL
        AND cn.mrid IS DISTINCT FROM COALESCE(ns.mrid, c.current_source)
      ORDER BY cn.geom <-> c.end_pt
      LIMIT 1
    ) ne ON TRUE
  ),
  scored AS (
    SELECT
      n.*,
      COALESCE(n.start_nearest, n.current_source) AS proposed_source,
      COALESCE(n.end_nearest, n.current_target) AS proposed_target,
      CASE
        WHEN COALESCE(n.start_dist_m, n.start_assigned_dist) <= p_tolerance_m
         AND COALESCE(n.end_dist_m, n.end_assigned_dist) <= p_tolerance_m
        THEN 'tier_a'
        WHEN COALESCE(n.start_dist_m, n.start_assigned_dist) <= p_assisted_m
         AND COALESCE(n.end_dist_m, n.end_assigned_dist) <= p_assisted_m
        THEN 'tier_b'
        ELSE NULL
      END AS tier,
      format(
        'start %.1fm (assigned %.1fm) · end %.1fm (assigned %.1fm)',
        COALESCE(n.start_dist_m, 0),
        COALESCE(n.start_assigned_dist, 0),
        COALESCE(n.end_dist_m, 0),
        COALESCE(n.end_assigned_dist, 0)
      ) AS rationale
    FROM nearest n
    WHERE (
      n.start_assigned_dist > p_tolerance_m
      OR n.end_assigned_dist > p_tolerance_m
      OR COALESCE(n.start_nearest, n.current_source) IS DISTINCT FROM n.current_source
      OR COALESCE(n.end_nearest, n.current_target) IS DISTINCT FROM n.current_target
    )
  ),
  filtered AS (
    SELECT *
    FROM scored
    WHERE tier IS NOT NULL
      AND (p_include_tier_b OR tier = 'tier_a')
      AND proposed_source IS NOT NULL
      AND proposed_target IS NOT NULL
      AND proposed_source <> proposed_target
    ORDER BY
      CASE tier WHEN 'tier_a' THEN 0 ELSE 1 END,
      GREATEST(COALESCE(start_dist_m, 0), COALESCE(end_dist_m, 0))
    LIMIT p_limit
  )
  INSERT INTO staging.line_endpoint_proposals (
    segment_mrid,
    district,
    current_source,
    current_target,
    proposed_source,
    proposed_target,
    start_dist_m,
    end_dist_m,
    start_nearest,
    end_nearest,
    tier,
    rationale,
    status,
    batch_id
  )
  SELECT
    segment_mrid,
    district,
    current_source,
    current_target,
    proposed_source,
    proposed_target,
    start_dist_m,
    end_dist_m,
    start_nearest,
    end_nearest,
    tier,
    rationale,
    'pending',
    v_batch
  FROM filtered;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  RETURN jsonb_build_object(
    'batch_id', v_batch,
    'district', v_district,
    'data_tier', 'staging',
    'inserted', v_inserted,
    'tier_a_pending', (
      SELECT COUNT(*)::bigint FROM staging.line_endpoint_proposals
      WHERE batch_id = v_batch AND tier = 'tier_a' AND status = 'pending'
    ),
    'tier_b_pending', (
      SELECT COUNT(*)::bigint FROM staging.line_endpoint_proposals
      WHERE batch_id = v_batch AND tier = 'tier_b' AND status = 'pending'
    ),
    'tolerance_m', p_tolerance_m,
    'assisted_m', p_assisted_m
  );
END;
$$;

CREATE OR REPLACE FUNCTION staging.apply_line_endpoint_fix_proposals(
  p_proposal_ids UUID[] DEFAULT NULL,
  p_district TEXT DEFAULT NULL,
  p_operator TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = staging, public
AS $$
DECLARE
  v_district TEXT := NULLIF(btrim(p_district), '');
  v_applied BIGINT := 0;
BEGIN
  WITH to_apply AS (
    SELECT p.id, p.segment_mrid, p.proposed_source, p.proposed_target
    FROM staging.line_endpoint_proposals p
    WHERE p.status = 'approved'
      AND (p_proposal_ids IS NULL OR p.id = ANY(p_proposal_ids))
      AND (v_district IS NULL OR p.district = v_district)
  ),
  updated AS (
    UPDATE staging.ac_line_segments als
    SET
      source_node_id = t.proposed_source,
      target_node_id = t.proposed_target
    FROM to_apply t
    WHERE als.mrid = t.segment_mrid
    RETURNING als.mrid
  ),
  marked AS (
    UPDATE staging.line_endpoint_proposals p
    SET
      status = 'applied',
      applied_at = now(),
      reviewed_by = COALESCE(p.reviewed_by, p_operator)
    FROM to_apply t
    WHERE p.id = t.id
    RETURNING p.id
  )
  SELECT COUNT(*)::bigint INTO v_applied FROM marked;

  RETURN jsonb_build_object(
    'applied', v_applied,
    'operator', p_operator,
    'district', v_district,
    'data_tier', 'staging'
  );
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON staging.line_endpoint_proposals TO service_role;
GRANT EXECUTE ON FUNCTION staging.generate_line_endpoint_fix_proposals(TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, BOOLEAN, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION staging.apply_line_endpoint_fix_proposals(UUID[], TEXT, TEXT) TO service_role;
