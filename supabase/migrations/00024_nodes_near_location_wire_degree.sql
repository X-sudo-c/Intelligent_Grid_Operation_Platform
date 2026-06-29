-- Mobile map: expose wire_degree and prefer wired nodes in nodes_near_location.

DROP FUNCTION IF EXISTS public.nodes_near_location(double precision, double precision, integer, double precision);

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
  scored AS (
    SELECT
      cn.mrid,
      cn.boundary_feeder_id,
      cn.geom,
      ST_Distance(
        cn.geom::geography,
        (SELECT geom FROM origin)::geography
      ) AS dist_m,
      (
        SELECT COUNT(*)::int
        FROM public.ac_line_segments als
        WHERE als.source_node_id = cn.mrid
           OR als.target_node_id = cn.mrid
      ) AS wire_degree,
      cn.geom <-> (SELECT geom FROM origin) AS dist_sort
    FROM public.connectivity_nodes cn
    JOIN public.identified_objects io ON io.mrid = cn.mrid
    CROSS JOIN origin o
    WHERE p_radius_m IS NULL
      OR ST_DWithin(cn.geom::geography, o.geom::geography, p_radius_m)
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
