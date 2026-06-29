-- Fix nodes_near_location: anon cannot SELECT ac_line_segments directly.
-- Use SECURITY DEFINER helper + KNN limit before wire_degree counts.

CREATE OR REPLACE FUNCTION public.node_wire_degree(p_mrid UUID)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::int
  FROM public.ac_line_segments als
  WHERE als.source_node_id = p_mrid
     OR als.target_node_id = p_mrid;
$$;

GRANT EXECUTE ON FUNCTION public.node_wire_degree(UUID) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.nodes_near_location(double precision, double precision, integer, double precision);
DROP FUNCTION IF EXISTS public.nodes_near_location(double precision, double precision, integer, double precision, boolean);

CREATE OR REPLACE FUNCTION public.nodes_near_location(
  p_lat double precision,
  p_lon double precision,
  p_limit integer DEFAULT 1000,
  p_radius_m double precision DEFAULT NULL,
  p_prefer_wired boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH origin AS (
    SELECT ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326) AS geom
  ),
  near AS (
    SELECT
      cn.mrid,
      cn.boundary_feeder_id,
      cn.geom,
      cn.geom <-> (SELECT geom FROM origin) AS dist_sort
    FROM public.connectivity_nodes cn
    JOIN public.identified_objects io ON io.mrid = cn.mrid
    WHERE p_radius_m IS NULL
      OR ST_DWithin(
        cn.geom::geography,
        (SELECT geom FROM origin)::geography,
        p_radius_m
      )
    ORDER BY dist_sort
    LIMIT GREATEST(50, LEAST(1000, p_limit))
  ),
  scored AS (
    SELECT
      n.mrid,
      n.boundary_feeder_id,
      n.geom,
      n.dist_sort,
      ST_Distance(
        n.geom::geography,
        (SELECT geom FROM origin)::geography
      ) AS dist_m,
      public.node_wire_degree(n.mrid) AS wire_degree
    FROM near n
  ),
  ranked AS (
    SELECT *
    FROM scored
    ORDER BY
      CASE WHEN p_prefer_wired THEN (wire_degree > 0) END DESC NULLS LAST,
      dist_sort
    LIMIT GREATEST(1, LEAST(p_limit, 1000))
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'mrid', r.mrid,
        'boundary_feeder_id', r.boundary_feeder_id,
        'geom', ST_AsGeoJSON(r.geom)::jsonb,
        'distance_m', r.dist_m,
        'wire_degree', r.wire_degree,
        'asset_kind', public.asset_kind_for_mrid(r.mrid),
        'identified_objects', jsonb_build_object(
          'name', io.name,
          'validation', io.validation,
          'ghana_grid_assets', (
            SELECT jsonb_build_object(
              'operating_utility', gga.operating_utility,
              'substation_name', gga.substation_name
            )
            FROM public.ghana_grid_assets gga
            WHERE gga.mrid = r.mrid
          )
        )
      )
      ORDER BY
        CASE WHEN p_prefer_wired THEN (r.wire_degree > 0) END DESC NULLS LAST,
        r.dist_m
    ),
    '[]'::jsonb
  )
  FROM ranked r
  JOIN public.identified_objects io ON io.mrid = r.mrid;
$$;

GRANT EXECUTE ON FUNCTION public.nodes_near_location(
  double precision,
  double precision,
  integer,
  double precision,
  boolean
) TO anon, authenticated;

-- node_connections RPC also reads ac_line_segments; run as definer for mobile REST.
CREATE OR REPLACE FUNCTION public.node_connections(
  p_mrid UUID,
  p_limit INTEGER DEFAULT 25
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH lim AS (
    SELECT GREATEST(1, LEAST(COALESCE(p_limit, 25), 100)) AS n
  ),
  downstream AS (
    SELECT
      als.mrid AS line_mrid,
      als.target_node_id AS neighbor_mrid,
      io.name AS neighbor_name,
      ce.nominal_voltage::text AS voltage,
      'downstream' AS direction,
      ST_AsGeoJSON(als.geom)::jsonb AS geom,
      ST_Y(tgt.geom) AS neighbor_lat,
      ST_X(tgt.geom) AS neighbor_lon
    FROM public.ac_line_segments als
    JOIN public.connectivity_nodes tgt ON tgt.mrid = als.target_node_id
    JOIN public.identified_objects io ON io.mrid = tgt.mrid
    LEFT JOIN public.conducting_equipment ce ON ce.mrid = als.mrid
    WHERE als.source_node_id = p_mrid
    LIMIT (SELECT n FROM lim)
  ),
  upstream AS (
    SELECT
      als.mrid AS line_mrid,
      als.source_node_id AS neighbor_mrid,
      io.name AS neighbor_name,
      ce.nominal_voltage::text AS voltage,
      'upstream' AS direction,
      ST_AsGeoJSON(als.geom)::jsonb AS geom,
      ST_Y(src.geom) AS neighbor_lat,
      ST_X(src.geom) AS neighbor_lon
    FROM public.ac_line_segments als
    JOIN public.connectivity_nodes src ON src.mrid = als.source_node_id
    JOIN public.identified_objects io ON io.mrid = src.mrid
    LEFT JOIN public.conducting_equipment ce ON ce.mrid = als.mrid
    WHERE als.target_node_id = p_mrid
    LIMIT (SELECT n FROM lim)
  )
  SELECT jsonb_build_object(
    'mrid', p_mrid,
    'downstream', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'line_mrid', line_mrid,
        'neighbor_mrid', neighbor_mrid,
        'neighbor_name', neighbor_name,
        'voltage', voltage,
        'direction', direction,
        'neighbor_lat', neighbor_lat,
        'neighbor_lon', neighbor_lon,
        'geom', geom
      ))
      FROM downstream
    ), '[]'::jsonb),
    'upstream', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'line_mrid', line_mrid,
        'neighbor_mrid', neighbor_mrid,
        'neighbor_name', neighbor_name,
        'voltage', voltage,
        'direction', direction,
        'neighbor_lat', neighbor_lat,
        'neighbor_lon', neighbor_lon,
        'geom', geom
      ))
      FROM upstream
    ), '[]'::jsonb),
    'degree', public.node_wire_degree(p_mrid)
  );
$$;

GRANT EXECUTE ON FUNCTION public.node_connections(UUID, INTEGER) TO anon, authenticated;
