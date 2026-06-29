-- Fast map load: separate code paths — instant KNN vs wired reorder with batched degree.

CREATE OR REPLACE FUNCTION public.nodes_near_location(
  p_lat double precision,
  p_lon double precision,
  p_limit integer DEFAULT 1000,
  p_radius_m double precision DEFAULT NULL,
  p_prefer_wired boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  lim integer := GREATEST(1, LEAST(p_limit, 1000));
BEGIN
  IF NOT p_prefer_wired THEN
    RETURN (
      WITH origin AS (
        SELECT ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326) AS geom
      ),
      ranked AS (
        SELECT
          cn.mrid,
          cn.boundary_feeder_id,
          cn.geom,
          ST_Distance(
            cn.geom::geography,
            (SELECT geom FROM origin)::geography
          ) AS dist_m
        FROM public.connectivity_nodes cn
        JOIN public.identified_objects io ON io.mrid = cn.mrid
        WHERE p_radius_m IS NULL
          OR ST_DWithin(
            cn.geom::geography,
            (SELECT geom FROM origin)::geography,
            p_radius_m
          )
        ORDER BY cn.geom <-> (SELECT geom FROM origin)
        LIMIT lim
      )
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'mrid', r.mrid,
            'boundary_feeder_id', r.boundary_feeder_id,
            'geom', ST_AsGeoJSON(r.geom)::jsonb,
            'distance_m', r.dist_m,
            'wire_degree', 0,
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
          ORDER BY r.dist_m
        ),
        '[]'::jsonb
      )
      FROM ranked r
      JOIN public.identified_objects io ON io.mrid = r.mrid
    );
  END IF;

  RETURN (
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
      LIMIT GREATEST(50, lim)
    ),
    wire_batch AS (
      SELECT e.mrid, COUNT(*)::int AS wire_degree
      FROM (
        SELECT als.source_node_id AS mrid
        FROM public.ac_line_segments als
        JOIN near n ON n.mrid = als.source_node_id
        UNION ALL
        SELECT als.target_node_id AS mrid
        FROM public.ac_line_segments als
        JOIN near n ON n.mrid = als.target_node_id
      ) e
      GROUP BY e.mrid
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
        COALESCE(wb.wire_degree, 0) AS wire_degree
      FROM near n
      LEFT JOIN wire_batch wb ON wb.mrid = n.mrid
    ),
    ranked AS (
      SELECT *
      FROM scored
      ORDER BY (wire_degree > 0) DESC, dist_sort
      LIMIT lim
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
        ORDER BY (r.wire_degree > 0) DESC, r.dist_m
      ),
      '[]'::jsonb
    )
    FROM ranked r
    JOIN public.identified_objects io ON io.mrid = r.mrid
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.nodes_near_location(
  double precision,
  double precision,
  integer,
  double precision,
  boolean
) TO anon, authenticated;
