-- Roman Ridge locality (Accra) — voice/map navigation centroid from OSM suburb boundary.
-- One canonical alias row; voice_normalize maps "romanridge" → "Roman Ridge".
-- District/region are resolved at query time via point-in-polygon.

UPDATE gis.place_aliases
SET lon = -0.1949429,
    lat = 5.6041482,
    source = 'osm_suburb',
    active = true
WHERE lower(trim(alias)) IN ('roman ridge', 'romanridge');

INSERT INTO gis.place_aliases (alias, lon, lat, source)
SELECT 'Roman Ridge', -0.1949429::double precision, 5.6041482, 'osm_suburb'
WHERE NOT EXISTS (
  SELECT 1
  FROM gis.place_aliases p
  WHERE lower(trim(p.alias)) IN ('roman ridge', 'romanridge')
);
