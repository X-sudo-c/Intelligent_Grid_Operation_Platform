-- Nima locality (Accra) — avoid fuzzy match to Roman Ridge for voice/map counts.
-- District/region resolved at query time via point-in-polygon.

INSERT INTO gis.place_aliases (alias, lon, lat, source)
SELECT 'Nima', -0.2030::double precision, 5.6037::double precision, 'osm_locality'
WHERE NOT EXISTS (
  SELECT 1
  FROM gis.place_aliases p
  WHERE lower(trim(p.alias)) = 'nima'
);

INSERT INTO gis.place_aliases (alias, lon, lat, source)
SELECT 'nima', -0.2030::double precision, 5.6037::double precision, 'osm_locality'
WHERE NOT EXISTS (
  SELECT 1
  FROM gis.place_aliases p
  WHERE lower(trim(p.alias)) = 'nima'
);
