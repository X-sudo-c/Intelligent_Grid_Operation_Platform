-- Speed up mobile node_connections on large ac_line_segments tables (~1M+ rows).

CREATE INDEX IF NOT EXISTS idx_ac_line_segments_source_node
  ON public.ac_line_segments (source_node_id);

CREATE INDEX IF NOT EXISTS idx_ac_line_segments_target_node
  ON public.ac_line_segments (target_node_id);

-- Fast RPC: index-friendly lookups, no geography distance sort, no GIS asset_kind call.
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
    'degree', (
      SELECT COUNT(*)::int
      FROM public.ac_line_segments als
      WHERE als.source_node_id = p_mrid OR als.target_node_id = p_mrid
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.node_connections(UUID, INTEGER) TO anon, authenticated;
