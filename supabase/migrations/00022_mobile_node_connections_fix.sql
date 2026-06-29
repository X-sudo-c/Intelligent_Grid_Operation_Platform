-- Mobile map: resilient node_connections (lines without conducting_equipment, neighbor coords).

CREATE OR REPLACE FUNCTION public.node_connections(
  p_mrid UUID,
  p_limit INTEGER DEFAULT 25
)
RETURNS jsonb
LANGUAGE sql
STABLE
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
      ST_X(tgt.geom) AS neighbor_lon,
      ST_Distance(cn.geom::geography, tgt.geom::geography) AS span_m
    FROM public.ac_line_segments als
    JOIN public.connectivity_nodes cn ON cn.mrid = als.source_node_id
    JOIN public.connectivity_nodes tgt ON tgt.mrid = als.target_node_id
    JOIN public.identified_objects io ON io.mrid = tgt.mrid
    LEFT JOIN public.conducting_equipment ce ON ce.mrid = als.mrid
    WHERE als.source_node_id = p_mrid
    ORDER BY span_m NULLS LAST
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
      ST_X(src.geom) AS neighbor_lon,
      ST_Distance(src.geom::geography, cn.geom::geography) AS span_m
    FROM public.ac_line_segments als
    JOIN public.connectivity_nodes cn ON cn.mrid = als.target_node_id
    JOIN public.connectivity_nodes src ON src.mrid = als.source_node_id
    JOIN public.identified_objects io ON io.mrid = src.mrid
    LEFT JOIN public.conducting_equipment ce ON ce.mrid = als.mrid
    WHERE als.target_node_id = p_mrid
    ORDER BY span_m NULLS LAST
    LIMIT (SELECT n FROM lim)
  )
  SELECT jsonb_build_object(
    'mrid', p_mrid,
    'asset_kind', public.asset_kind_for_mrid(p_mrid),
    'downstream', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'line_mrid', line_mrid,
        'neighbor_mrid', neighbor_mrid,
        'neighbor_name', neighbor_name,
        'voltage', voltage,
        'direction', direction,
        'span_m', span_m,
        'neighbor_lat', neighbor_lat,
        'neighbor_lon', neighbor_lon,
        'geom', geom
      ) ORDER BY span_m)
      FROM downstream
    ), '[]'::jsonb),
    'upstream', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'line_mrid', line_mrid,
        'neighbor_mrid', neighbor_mrid,
        'neighbor_name', neighbor_name,
        'voltage', voltage,
        'direction', direction,
        'span_m', span_m,
        'neighbor_lat', neighbor_lat,
        'neighbor_lon', neighbor_lon,
        'geom', geom
      ) ORDER BY span_m)
      FROM upstream
    ), '[]'::jsonb),
    'degree', (
      SELECT COUNT(*)::int
      FROM public.ac_line_segments als
      WHERE als.source_node_id = p_mrid OR als.target_node_id = p_mrid
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.node_connections(UUID, INTEGER) TO anon, authenticated;
