-- GIS reference layer catalog + async import enqueue helper.
-- Reference layers live in gis.* and inform capture/validation — they are not CIM master data.

CREATE TABLE IF NOT EXISTS gis.reference_layers (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug                        TEXT NOT NULL UNIQUE,
  display_name                TEXT NOT NULL,
  description                 TEXT,
  kind                        TEXT NOT NULL CHECK (kind IN ('boundary', 'network', 'overlay')),
  target_schema               TEXT NOT NULL DEFAULT 'gis',
  target_table                TEXT NOT NULL,
  martin_source_id            TEXT,
  gpkg_layer_name             TEXT,
  geometry_type               TEXT,
  min_zoom                    NUMERIC,
  max_zoom                    NUMERIC,
  sort_order                  INT NOT NULL DEFAULT 0,
  active                      BOOLEAN NOT NULL DEFAULT TRUE,
  requires_post_import_refresh BOOLEAN NOT NULL DEFAULT FALSE,
  feature_count               BIGINT,
  last_imported_at            TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reference_layers_kind_active
  ON gis.reference_layers (kind, active, sort_order);

COMMENT ON TABLE gis.reference_layers IS
  'Catalog of GIS reference overlays (boundaries, legacy network, contextual layers).';

-- Seed known layers from Power System.gpkg and derived views.
INSERT INTO gis.reference_layers (
  slug, display_name, description, kind,
  target_schema, target_table, martin_source_id, gpkg_layer_name,
  geometry_type, min_zoom, max_zoom, sort_order,
  requires_post_import_refresh
) VALUES
  (
    'ecg-admin-boundaries',
    'ECG administrative boundaries',
    'District and region polygons for territory scoping and field assignment.',
    'boundary',
    'gis', 'ecg_admin_boundaries', 'ecg_admin_boundaries', 'ECG-Admin_Boundaries',
    'MULTIPOLYGON', 0, 14, 10,
    FALSE
  ),
  (
    'ecg-admin-regions',
    'ECG regions (derived)',
    'Regional outlines unioned from district boundaries — auto-refreshes from ecg_admin_boundaries.',
    'boundary',
    'gis', 'ecg_admin_regions', 'ecg_admin_regions', NULL,
    'MULTIPOLYGON', 0, 10, 11,
    FALSE
  ),
  (
    'oh-conductor-33kv',
    '33 kV overhead conductors (reference)',
    'Legacy GIS overhead conductors — map backdrop and H3 reference counts only.',
    'network',
    'gis', 'oh_conductor_33kv', 'oh_conductor_33kv', 'oh_conductor_33kv',
    'LINESTRING', 6, 14, 20,
    TRUE
  ),
  (
    'oh-conductor-11kv',
    '11 kV overhead conductors (reference)',
    'Legacy GIS overhead conductors — map backdrop and H3 reference counts only.',
    'network',
    'gis', 'oh_conductor_11kv', 'oh_conductor_11kv', 'oh_conductor_11kv',
    'LINESTRING', 6, 14, 21,
    TRUE
  ),
  (
    'ug-cable-33kv',
    '33 kV underground cables (reference)',
    'Legacy GIS underground cables — map backdrop only.',
    'network',
    'gis', 'ug_cable_33kv', 'ug_cable_33kv', 'taa_data__dbo_ug_cable_33kv_evw',
    'LINESTRING', 6, 14, 22,
    TRUE
  ),
  (
    'ug-cable-11kv',
    '11 kV underground cables (reference)',
    'Legacy GIS underground cables — map backdrop only.',
    'network',
    'gis', 'ug_cable_11kv', 'ug_cable_11kv', 'ug_cable_11kv',
    'LINESTRING', 6, 14, 23,
    TRUE
  ),
  (
    'power-transformer',
    'Power transformers (reference)',
    'Legacy GIS power transformers — map icons and snap context only.',
    'network',
    'gis', 'power_transformer', 'power_transformer', 'power_transformer',
    'POINT', 5, 14, 30,
    TRUE
  ),
  (
    'distribution-transformer',
    'Distribution transformers (reference)',
    'Legacy GIS distribution transformers — map icons and snap context only.',
    'network',
    'gis', 'distribution_transformer', 'distribution_transformer', 'distribution_transformer',
    'POINT', 12, 14, 31,
    TRUE
  )
ON CONFLICT (slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  kind = EXCLUDED.kind,
  martin_source_id = EXCLUDED.martin_source_id,
  gpkg_layer_name = EXCLUDED.gpkg_layer_name,
  geometry_type = EXCLUDED.geometry_type,
  min_zoom = EXCLUDED.min_zoom,
  max_zoom = EXCLUDED.max_zoom,
  sort_order = EXCLUDED.sort_order,
  requires_post_import_refresh = EXCLUDED.requires_post_import_refresh,
  updated_at = NOW();

CREATE OR REPLACE FUNCTION gis.refresh_reference_layer_counts()
RETURNS void AS $$
DECLARE
  rec RECORD;
  v_count BIGINT;
  v_sql TEXT;
BEGIN
  FOR rec IN
    SELECT slug, target_schema, target_table
    FROM gis.reference_layers
    WHERE active = TRUE
      AND target_table IS NOT NULL
      AND gpkg_layer_name IS NOT NULL
  LOOP
    v_sql := format(
      'SELECT COUNT(*) FROM %I.%I',
      rec.target_schema,
      rec.target_table
    );
    EXECUTE v_sql INTO v_count;
    UPDATE gis.reference_layers
    SET feature_count = v_count, updated_at = NOW()
    WHERE slug = rec.slug;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

GRANT SELECT ON gis.reference_layers TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION gis.refresh_reference_layer_counts() TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_gis_import_job(p_job_id UUID)
RETURNS BIGINT AS $$
DECLARE
  v_msg_id BIGINT;
BEGIN
  SELECT pgmq.send(
    'gis_import_jobs',
    jsonb_build_object('job_id', p_job_id::text)
  ) INTO v_msg_id;
  RETURN v_msg_id;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION public.enqueue_gis_import_job(UUID) TO service_role;
