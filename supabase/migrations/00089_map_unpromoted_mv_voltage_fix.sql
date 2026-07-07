-- Fix MV refresh: avoid gis.voltage_class_to_enum (enum not visible during REFRESH).

DROP MATERIALIZED VIEW IF EXISTS public.map_unpromoted_conductor_segments;

CREATE MATERIALIZED VIEW public.map_unpromoted_conductor_segments AS
WITH line AS (
  SELECT
    cs.id,
    cs.source_layer,
    cs.source_fid,
    cs.district,
    cs.voltage_class,
    gis.as_linestring(cs.geom)::geometry(LineString, 4326) AS geom
  FROM gis.conductor_segments cs
  WHERE cs.geom IS NOT NULL
)
SELECT
  l.id,
  l.source_layer,
  CASE l.voltage_class
    WHEN 'MV_11KV' THEN 'MV_11KV'
    WHEN 'MV_33KV' THEN 'MV_33KV'
    WHEN 'LV' THEN 'LV_400V'
    ELSE 'MV_11KV'
  END AS nominal_voltage,
  l.district,
  CASE
    WHEN l.source_layer LIKE 'ug\_%' ESCAPE '\' THEN 'UNDERGROUND'
    ELSE 'OVERHEAD'
  END AS installation_type,
  l.geom,
  ST_Length(l.geom::geography) AS length_m
FROM line l
WHERE l.geom IS NOT NULL
  AND ST_Length(l.geom::geography) <= 50000
  AND NOT EXISTS (
    SELECT 1
    FROM public.ac_line_segments als
    WHERE als.mrid = gis.conductor_segment_mrid(l.source_layer, l.source_fid)
  )
WITH NO DATA;

CREATE UNIQUE INDEX idx_map_unpromoted_conductor_segments_id
  ON public.map_unpromoted_conductor_segments (id);

CREATE INDEX idx_map_unpromoted_conductor_segments_geom
  ON public.map_unpromoted_conductor_segments USING GIST (geom);

GRANT SELECT ON public.map_unpromoted_conductor_segments TO anon, authenticated, service_role;

-- MV refresh inlines gis.as_linestring; ensure PostGIS types resolve.
ALTER FUNCTION gis.as_linestring(geometry) SET search_path = public, gis, topology;

SELECT public.refresh_map_unpromoted_conductor_segments(FALSE);
