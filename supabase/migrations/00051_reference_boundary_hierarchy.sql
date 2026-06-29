-- Boundary hierarchy config for multi-company reference imports.

ALTER TABLE gis.reference_layers
  ADD COLUMN IF NOT EXISTS parent_slug TEXT REFERENCES gis.reference_layers(slug) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dissolve_column TEXT,
  ADD COLUMN IF NOT EXISTS label_field TEXT,
  ADD COLUMN IF NOT EXISTS detail_min_zoom NUMERIC DEFAULT 10,
  ADD COLUMN IF NOT EXISTS is_overview_derived BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.gis_transfer_jobs
  ADD COLUMN IF NOT EXISTS import_config JSONB;

COMMENT ON COLUMN gis.reference_layers.parent_slug IS
  'Overview layer points to its detail parent (e.g. regions derived from districts).';
COMMENT ON COLUMN gis.reference_layers.dissolve_column IS
  'On detail layers: attribute used to build the derived overview (ST_Union GROUP BY).';
COMMENT ON COLUMN gis.reference_layers.detail_min_zoom IS
  'Map zoom at/above which detail polygons replace overview dissolve.';

UPDATE gis.reference_layers
SET dissolve_column = 'region',
    label_field = 'district',
    detail_min_zoom = 10,
    is_overview_derived = FALSE
WHERE slug = 'ecg-admin-boundaries';

UPDATE gis.reference_layers
SET parent_slug = 'ecg-admin-boundaries',
    label_field = 'region',
    detail_min_zoom = 10,
    is_overview_derived = TRUE,
    max_zoom = 10
WHERE slug = 'ecg-admin-regions';

-- Generic overview view from any detail boundary table + dissolve column.
CREATE OR REPLACE FUNCTION gis.ensure_boundary_overview_view(
  p_detail_schema TEXT,
  p_detail_table TEXT,
  p_overview_name TEXT,
  p_dissolve_column TEXT
) RETURNS void AS $$
DECLARE
  v_sql TEXT;
BEGIN
  IF p_dissolve_column !~ '^[a-zA-Z_][a-zA-Z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid dissolve column: %', p_dissolve_column;
  END IF;
  IF p_detail_table !~ '^[a-zA-Z_][a-zA-Z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid detail table: %', p_detail_table;
  END IF;
  IF p_overview_name !~ '^[a-zA-Z_][a-zA-Z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid overview name: %', p_overview_name;
  END IF;

  v_sql := format(
    'CREATE OR REPLACE VIEW %I.%I AS
     SELECT
       (row_number() OVER (ORDER BY %I))::int4 AS fid,
       %I::text AS %I,
       ST_Multi(ST_Union(geom))::geometry(MultiPolygon, 4326) AS geom
     FROM %I.%I
     WHERE %I IS NOT NULL AND btrim(%I::text) <> ''''
     GROUP BY %I',
    p_detail_schema, p_overview_name,
    p_dissolve_column,
    p_dissolve_column, p_dissolve_column,
    p_detail_schema, p_detail_table,
    p_dissolve_column, p_dissolve_column,
    p_dissolve_column
  );
  EXECUTE v_sql;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION gis.ensure_boundary_overview_view(TEXT, TEXT, TEXT, TEXT) TO service_role;

-- Keep ECG view in sync with generic helper (region dissolve).
SELECT gis.ensure_boundary_overview_view('gis', 'ecg_admin_boundaries', 'ecg_admin_regions', 'region');
