-- Close micro-gaps between adjacent districts before dissolve so overview polygons
-- do not contain hundreds of spurious interior rings (visible as low-zoom map artifacts).

DROP FUNCTION IF EXISTS gis.ensure_boundary_overview_view(TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION gis.ensure_boundary_overview_view(
  p_detail_schema TEXT,
  p_detail_table TEXT,
  p_overview_name TEXT,
  p_dissolve_column TEXT,
  p_close_meters DOUBLE PRECISION DEFAULT 15
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
       ST_Multi(
         ST_SimplifyPreserveTopology(
           ST_Buffer(
             ST_Buffer(
               ST_UnaryUnion(ST_Collect(geom))::geography,
               %s
             )::geometry::geography,
             -%s
           )::geometry,
           0.00003
         )
       )::geometry(MultiPolygon, 4326) AS geom
     FROM %I.%I
     WHERE %I IS NOT NULL AND btrim(%I::text) <> ''''
     GROUP BY %I',
    p_detail_schema, p_overview_name,
    p_dissolve_column,
    p_dissolve_column, p_dissolve_column,
    p_close_meters, p_close_meters,
    p_detail_schema, p_detail_table,
    p_dissolve_column, p_dissolve_column,
    p_dissolve_column
  );
  EXECUTE v_sql;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION gis.ensure_boundary_overview_view(TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION) TO service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'gis' AND table_name = 'ecg_admin_boundaries'
  ) THEN
    PERFORM gis.ensure_boundary_overview_view(
      'gis', 'ecg_admin_boundaries', 'ecg_admin_regions', 'region'
    );
  END IF;
END $$;
