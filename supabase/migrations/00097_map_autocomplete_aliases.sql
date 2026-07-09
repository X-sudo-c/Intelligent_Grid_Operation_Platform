-- Map autocomplete: restore place-alias trigram index + seed high-value Accra POIs.

CREATE INDEX IF NOT EXISTS idx_place_aliases_trgm
  ON gis.place_aliases
  USING gin (alias extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_place_aliases_active
  ON gis.place_aliases (active) WHERE active;

INSERT INTO gis.place_aliases (alias, lon, lat, source)
SELECT v.alias, v.lon, v.lat, v.source
FROM (
  VALUES
    ('Continental Plaza', -0.1944525::double precision, 5.6156668::double precision, 'osm_poi'),
    ('Continental Hotel', -0.1944525, 5.6156668, 'osm_poi'),
    ('Continental Road', -0.1978818, 5.6051809, 'osm_road'),
    ('Continental', -0.1944525, 5.6156668, 'osm_poi'),
    ('Okomfo Anokye Road', -1.62384345, 6.69825835, 'osm_road'),
    ('Yaa Asantewaa Road', -1.6130539, 6.70042835, 'osm_road'),
    ('Adonten SE Road', -1.6184067, 6.69575405, 'osm_road'),
    ('Adonten S. E. Road', -1.6184067, 6.69575405, 'osm_road'),
    ('Adonten S E Road', -1.6184067, 6.69575405, 'osm_road')
) AS v(alias, lon, lat, source)
WHERE NOT EXISTS (
  SELECT 1 FROM gis.place_aliases p WHERE lower(trim(p.alias)) = lower(trim(v.alias))
);
