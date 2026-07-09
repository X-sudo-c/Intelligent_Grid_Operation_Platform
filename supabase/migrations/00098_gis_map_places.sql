-- National OSM place index for map autocomplete and copilot place resolution.
-- Populated by sync-service/scripts/import_osm_map_places.py (Geofabrik Ghana PBF).

CREATE TABLE IF NOT EXISTS gis.map_places (
  id            bigserial PRIMARY KEY,
  osm_id        bigint NOT NULL,
  osm_type      text NOT NULL CHECK (osm_type IN ('node', 'way', 'relation')),
  name          text NOT NULL,
  name_norm     text NOT NULL,
  place_type    text NOT NULL,
  city          text,
  district      text,
  region        text,
  lon           double precision NOT NULL,
  lat           double precision NOT NULL,
  centroid      geometry(Point, 4326) NOT NULL,
  west          double precision,
  south         double precision,
  east          double precision,
  north         double precision,
  source        text NOT NULL DEFAULT 'osm',
  active        boolean NOT NULL DEFAULT true,
  imported_at   timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_map_places_osm
  ON gis.map_places (osm_type, osm_id);

CREATE INDEX IF NOT EXISTS idx_map_places_name_norm_trgm
  ON gis.map_places
  USING gin (name_norm extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_map_places_centroid
  ON gis.map_places
  USING gist (centroid);

CREATE INDEX IF NOT EXISTS idx_map_places_active_type
  ON gis.map_places (place_type)
  WHERE active;

CREATE INDEX IF NOT EXISTS idx_map_places_name_prefix
  ON gis.map_places (name_norm text_pattern_ops)
  WHERE active;

COMMENT ON TABLE gis.map_places IS
  'OSM-backed roads, localities, and POIs for Ghana map autocomplete (Geofabrik import).';
