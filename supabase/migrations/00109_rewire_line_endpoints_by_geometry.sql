-- Geom-preserving master FK rewire: when a line tip sits on a connectivity node
-- but source/target points at a far/wrong node, rewire the FK and optionally
-- ST_SetPoint the tip. Does NOT ST_MakeLine (preserves as-built vertices).
-- Set-based apply; proposed/applied arrays are capped samples for API payloads.

CREATE OR REPLACE FUNCTION public.rewire_line_endpoints_by_geometry(
  p_west DOUBLE PRECISION,
  p_south DOUBLE PRECISION,
  p_east DOUBLE PRECISION,
  p_north DOUBLE PRECISION,
  p_tip_tol_m DOUBLE PRECISION DEFAULT 1.0,
  p_far_fk_m DOUBLE PRECISION DEFAULT 50.0,
  p_dry_run BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_env geometry;
  v_tip_tol DOUBLE PRECISION := GREATEST(COALESCE(p_tip_tol_m, 1.0), 0.05);
  v_far_fk DOUBLE PRECISION := GREATEST(COALESCE(p_far_fk_m, 50.0), v_tip_tol);
  v_snap_eps DOUBLE PRECISION := 0.05;
  v_sample_cap INT := 100;
  v_candidates BIGINT := 0;
  v_rewire_rows BIGINT := 0;
  v_applied BIGINT := 0;
  v_self_loops BIGINT := 0;
  v_geom_snapped BIGINT := 0;
  v_proposed JSONB := '[]'::JSONB;
  v_applied_sample JSONB := '[]'::JSONB;
  v_skipped JSONB := '[]'::JSONB;
  v_started TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_west IS NULL OR p_south IS NULL OR p_east IS NULL OR p_north IS NULL THEN
    RAISE EXCEPTION 'bbox west/south/east/north required';
  END IF;
  IF p_west >= p_east OR p_south >= p_north THEN
    RAISE EXCEPTION 'invalid bbox: west < east and south < north required';
  END IF;

  v_env := ST_MakeEnvelope(p_west, p_south, p_east, p_north, 4326);

  DROP TABLE IF EXISTS _rewire_plan;
  CREATE TEMP TABLE _rewire_plan ON COMMIT DROP AS
  WITH segs AS (
    SELECT
      als.mrid,
      als.source_node_id,
      als.target_node_id,
      ST_Force2D(als.geom) AS geom2d
    FROM public.ac_line_segments als
    WHERE als.geom && v_env
      AND ST_NPoints(ST_Force2D(als.geom)) >= 2
  ),
  tips AS (
    SELECT
      s.*,
      ST_StartPoint(s.geom2d) AS start_pt,
      ST_EndPoint(s.geom2d) AS end_pt
    FROM segs s
  ),
  start_near AS (
    SELECT DISTINCT ON (t.mrid)
      t.mrid,
      cn.mrid AS near_mrid,
      cn.geom AS near_geom,
      ST_DistanceSphere(t.start_pt, cn.geom) AS tip_dist_m
    FROM tips t
    JOIN public.connectivity_nodes cn
      ON cn.geom && ST_Expand(t.start_pt, 0.00005)
     AND ST_DWithin(t.start_pt::geography, cn.geom::geography, v_tip_tol)
    ORDER BY t.mrid, t.start_pt <-> cn.geom
  ),
  end_near AS (
    SELECT DISTINCT ON (t.mrid)
      t.mrid,
      cn.mrid AS near_mrid,
      cn.geom AS near_geom,
      ST_DistanceSphere(t.end_pt, cn.geom) AS tip_dist_m
    FROM tips t
    JOIN public.connectivity_nodes cn
      ON cn.geom && ST_Expand(t.end_pt, 0.00005)
     AND ST_DWithin(t.end_pt::geography, cn.geom::geography, v_tip_tol)
    ORDER BY t.mrid, t.end_pt <-> cn.geom
  ),
  scored AS (
    SELECT
      t.mrid,
      t.source_node_id,
      t.target_node_id,
      t.geom2d,
      sn.near_mrid AS start_near_mrid,
      sn.near_geom AS start_near_geom,
      sn.tip_dist_m AS start_tip_dist_m,
      en.near_mrid AS end_near_mrid,
      en.near_geom AS end_near_geom,
      en.tip_dist_m AS end_tip_dist_m,
      CASE WHEN src.geom IS NULL THEN NULL
           ELSE ST_DistanceSphere(t.start_pt, src.geom) END AS start_fk_dist_m,
      CASE WHEN tgt.geom IS NULL THEN NULL
           ELSE ST_DistanceSphere(t.end_pt, tgt.geom) END AS end_fk_dist_m
    FROM tips t
    LEFT JOIN start_near sn ON sn.mrid = t.mrid
    LEFT JOIN end_near en ON en.mrid = t.mrid
    LEFT JOIN public.connectivity_nodes src ON src.mrid = t.source_node_id
    LEFT JOIN public.connectivity_nodes tgt ON tgt.mrid = t.target_node_id
  ),
  planned AS (
    SELECT
      s.*,
      CASE
        WHEN s.start_near_mrid IS NOT NULL
         AND (s.start_fk_dist_m IS NULL OR s.start_fk_dist_m > v_far_fk)
         AND s.source_node_id IS DISTINCT FROM s.start_near_mrid
        THEN s.start_near_mrid
        ELSE s.source_node_id
      END AS new_source,
      CASE
        WHEN s.end_near_mrid IS NOT NULL
         AND (s.end_fk_dist_m IS NULL OR s.end_fk_dist_m > v_far_fk)
         AND s.target_node_id IS DISTINCT FROM s.end_near_mrid
        THEN s.end_near_mrid
        ELSE s.target_node_id
      END AS new_target
    FROM scored s
  )
  SELECT
    p.*,
    (p.new_source IS DISTINCT FROM p.source_node_id
      OR p.new_target IS DISTINCT FROM p.target_node_id) AS needs_rewire,
    (p.new_source IS NOT NULL AND p.new_target IS NOT NULL
      AND p.new_source = p.new_target) AS is_self_loop,
    CASE
      WHEN p.new_source IS DISTINCT FROM p.source_node_id
       AND p.start_near_geom IS NOT NULL
       AND COALESCE(p.start_tip_dist_m, 0) > v_snap_eps
      THEN TRUE ELSE FALSE
    END AS snap_start,
    CASE
      WHEN p.new_target IS DISTINCT FROM p.target_node_id
       AND p.end_near_geom IS NOT NULL
       AND COALESCE(p.end_tip_dist_m, 0) > v_snap_eps
      THEN TRUE ELSE FALSE
    END AS snap_end
  FROM planned p;

  SELECT COUNT(*) INTO v_candidates FROM _rewire_plan;

  SELECT COUNT(*) INTO v_self_loops
  FROM _rewire_plan WHERE needs_rewire AND is_self_loop;

  SELECT COALESCE(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
  INTO v_skipped
  FROM (
    SELECT mrid AS segment_mrid, new_source, new_target, 'self_loop' AS reason
    FROM _rewire_plan
    WHERE needs_rewire AND is_self_loop
    LIMIT v_sample_cap
  ) x;

  SELECT COUNT(*) INTO v_rewire_rows
  FROM _rewire_plan
  WHERE needs_rewire AND NOT is_self_loop;

  SELECT COALESCE(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
  INTO v_proposed
  FROM (
    SELECT
      mrid AS segment_mrid,
      source_node_id AS old_source,
      target_node_id AS old_target,
      new_source,
      new_target,
      round(COALESCE(start_tip_dist_m, 0)::numeric, 3) AS start_tip_dist_m,
      round(COALESCE(end_tip_dist_m, 0)::numeric, 3) AS end_tip_dist_m,
      CASE WHEN start_fk_dist_m IS NULL THEN NULL
           ELSE round(start_fk_dist_m::numeric, 2) END AS start_fk_dist_m,
      CASE WHEN end_fk_dist_m IS NULL THEN NULL
           ELSE round(end_fk_dist_m::numeric, 2) END AS end_fk_dist_m,
      (snap_start OR snap_end) AS geom_tip_snapped,
      snap_start,
      snap_end
    FROM _rewire_plan
    WHERE needs_rewire AND NOT is_self_loop
    ORDER BY mrid
    LIMIT v_sample_cap
  ) x;

  IF p_dry_run THEN
    SELECT COUNT(*) INTO v_geom_snapped
    FROM _rewire_plan
    WHERE needs_rewire AND NOT is_self_loop AND (snap_start OR snap_end);

    RETURN jsonb_build_object(
      'dry_run', TRUE,
      'bbox', jsonb_build_object(
        'west', p_west, 'south', p_south, 'east', p_east, 'north', p_north
      ),
      'tip_tol_m', v_tip_tol,
      'far_fk_m', v_far_fk,
      'proposed', v_proposed,
      'applied', '[]'::jsonb,
      'skipped', v_skipped,
      'stats', jsonb_build_object(
        'candidates', v_candidates,
        'rewired', v_rewire_rows,
        'geom_tip_snapped', v_geom_snapped,
        'proposed_count', v_rewire_rows,
        'proposed_sample', jsonb_array_length(v_proposed),
        'applied_count', 0,
        'skipped_count', v_self_loops,
        'elapsed_ms', round(
          EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) * 1000.0
        )::bigint
      )
    );
  END IF;

  -- Apply: FK rewrite + optional tip ST_SetPoint (path preserved).
  WITH upd AS (
    UPDATE public.ac_line_segments als
    SET
      source_node_id = p.new_source,
      target_node_id = p.new_target,
      geom = CASE
        WHEN p.snap_start OR p.snap_end THEN
          ST_SetPoint(
            CASE
              WHEN p.snap_start THEN ST_SetPoint(p.geom2d, 0, p.start_near_geom)
              ELSE p.geom2d
            END,
            GREATEST(
              ST_NPoints(
                CASE
                  WHEN p.snap_start THEN ST_SetPoint(p.geom2d, 0, p.start_near_geom)
                  ELSE p.geom2d
                END
              ) - 1,
              0
            ),
            CASE WHEN p.snap_end THEN p.end_near_geom
                 ELSE ST_EndPoint(
                   CASE
                     WHEN p.snap_start THEN ST_SetPoint(p.geom2d, 0, p.start_near_geom)
                     ELSE p.geom2d
                   END
                 )
            END
          )
        ELSE als.geom
      END
    FROM _rewire_plan p
    WHERE als.mrid = p.mrid
      AND p.needs_rewire
      AND NOT p.is_self_loop
      AND (
        als.source_node_id IS DISTINCT FROM p.new_source
        OR als.target_node_id IS DISTINCT FROM p.new_target
      )
    RETURNING als.mrid, p.snap_start, p.snap_end
  )
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE snap_start OR snap_end)
  INTO v_applied, v_geom_snapped
  FROM upd;

  SELECT COALESCE(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
  INTO v_applied_sample
  FROM (
    SELECT
      mrid AS segment_mrid,
      source_node_id AS old_source,
      target_node_id AS old_target,
      new_source,
      new_target,
      (snap_start OR snap_end) AS geom_tip_snapped
    FROM _rewire_plan
    WHERE needs_rewire AND NOT is_self_loop
    ORDER BY mrid
    LIMIT v_sample_cap
  ) x;

  RETURN jsonb_build_object(
    'dry_run', FALSE,
    'bbox', jsonb_build_object(
      'west', p_west, 'south', p_south, 'east', p_east, 'north', p_north
    ),
    'tip_tol_m', v_tip_tol,
    'far_fk_m', v_far_fk,
    'proposed', '[]'::jsonb,
    'applied', v_applied_sample,
    'skipped', v_skipped,
    'stats', jsonb_build_object(
      'candidates', v_candidates,
      'rewired', v_applied,
      'geom_tip_snapped', v_geom_snapped,
      'proposed_count', 0,
      'applied_count', v_applied,
      'applied_sample', jsonb_array_length(v_applied_sample),
      'skipped_count', v_self_loops,
      'elapsed_ms', round(
        EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) * 1000.0
      )::bigint
    )
  );
END;
$$;

COMMENT ON FUNCTION public.rewire_line_endpoints_by_geometry(
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  DOUBLE PRECISION, DOUBLE PRECISION, BOOLEAN
) IS
  'Bbox master FK rewire: tip within tip_tol_m of a node and current FK farther than far_fk_m → rewire; preserve path (optional ST_SetPoint).';

GRANT EXECUTE ON FUNCTION public.rewire_line_endpoints_by_geometry(
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  DOUBLE PRECISION, DOUBLE PRECISION, BOOLEAN
) TO service_role;
