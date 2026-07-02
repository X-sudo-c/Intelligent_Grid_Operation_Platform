-- Locality aliases for voice/chat place resolution (towns → ECG district + point).
-- Point-in-polygon against gis.ecg_admin_boundaries fills district/region when omitted.

CREATE TABLE IF NOT EXISTS gis.place_aliases (
  id serial PRIMARY KEY,
  alias text NOT NULL,
  district text,
  region text,
  lon double precision,
  lat double precision,
  source text NOT NULL DEFAULT 'seed',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_place_aliases_alias_lower
  ON gis.place_aliases (lower(trim(alias)));

CREATE INDEX IF NOT EXISTS idx_place_aliases_trgm
  ON gis.place_aliases
  USING gin (alias extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_place_aliases_active
  ON gis.place_aliases (active) WHERE active;

-- Approximate centroids — district/region resolved at query time via ST_Within when null.
INSERT INTO gis.place_aliases (alias, lon, lat, source)
SELECT v.alias, v.lon, v.lat, v.source
FROM (
  VALUES
    ('Pokuase', -0.283::double precision, 5.667::double precision, 'seed'),
    ('Gbawe', -0.317, 5.567, 'seed'),
    ('Kasoa', -0.417, 5.534, 'seed'),
    ('Madina', -0.167, 5.683, 'seed'),
    ('Ashaiman', -0.029, 5.694, 'seed'),
    ('Teshie', -0.107, 5.583, 'seed'),
    ('Nungua', -0.082, 5.601, 'seed'),
    ('Osu', -0.174, 5.556, 'seed'),
    ('Legon', -0.186, 5.650, 'seed'),
    ('East Legon', -0.157, 5.635, 'seed'),
    ('Spintex', -0.078, 5.636, 'seed'),
    ('Adenta', -0.154, 5.710, 'seed'),
    ('Dansoman', -0.263, 5.537, 'seed'),
    ('Weija', -0.345, 5.558, 'seed'),
    ('Haatso', -0.228, 5.672, 'seed'),
    ('Ablekuma', -0.245, 5.592, 'seed'),
    ('Labadi', -0.152, 5.564, 'seed'),
    ('Tema New Town', 0.001, 5.669, 'seed'),
    ('Community 1', 0.018, 5.651, 'seed'),
    ('Sakumono', -0.064, 5.628, 'seed')
) AS v(alias, lon, lat, source)
WHERE NOT EXISTS (
  SELECT 1 FROM gis.place_aliases p WHERE lower(trim(p.alias)) = lower(trim(v.alias))
);
