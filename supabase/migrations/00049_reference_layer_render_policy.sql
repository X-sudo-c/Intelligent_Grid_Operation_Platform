-- Dynamic render policy for GIS reference layers (Martin vs GeoJSON by size/kind).

ALTER TABLE gis.reference_layers
  ADD COLUMN IF NOT EXISTS render_mode TEXT NOT NULL DEFAULT 'martin'
    CHECK (render_mode IN ('martin', 'geojson_static', 'geojson_bbox', 'none')),
  ADD COLUMN IF NOT EXISTS built_in_map_style BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bbox_west DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS bbox_south DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS bbox_east DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS bbox_north DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS vertex_count BIGINT,
  ADD COLUMN IF NOT EXISTS table_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS render_stats JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN gis.reference_layers.render_mode IS
  'How the portal map delivers this layer: martin MVT, full GeoJSON, bbox-fetched GeoJSON, or hidden.';
COMMENT ON COLUMN gis.reference_layers.built_in_map_style IS
  'When true, layer is already defined in giopMapLayers.ts (Martin). GeoJSON modes hide built-in tiles.';

UPDATE gis.reference_layers SET built_in_map_style = TRUE
WHERE slug IN (
  'ecg-admin-boundaries',
  'ecg-admin-regions',
  'oh-conductor-33kv',
  'oh-conductor-11kv',
  'ug-cable-33kv',
  'ug-cable-11kv',
  'power-transformer',
  'distribution-transformer'
);

-- Default network layers to martin; boundaries get policy assigned after import/stats refresh.
UPDATE gis.reference_layers SET render_mode = 'martin'
WHERE kind = 'network';

UPDATE gis.reference_layers SET render_mode = 'none'
WHERE feature_count IS NULL OR feature_count = 0;
