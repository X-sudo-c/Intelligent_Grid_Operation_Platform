-- Tema city (port/industrial area) — not the whole Tema Region polygon.
-- OSM city center; district resolved via point-in-polygon at query time.

UPDATE gis.place_aliases
SET lon = -0.017573,
    lat = 5.666951,
    source = 'osm_city',
    active = true
WHERE lower(trim(alias)) = 'tema';

INSERT INTO gis.place_aliases (alias, lon, lat, source)
SELECT 'Tema', -0.017573::double precision, 5.666951, 'osm_city'
WHERE NOT EXISTS (
  SELECT 1 FROM gis.place_aliases p WHERE lower(trim(p.alias)) = 'tema'
);
