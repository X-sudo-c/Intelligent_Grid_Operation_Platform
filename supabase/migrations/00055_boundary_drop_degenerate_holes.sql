-- Remove degenerate interior rings (0-area slivers) from dissolved overview polygons.
-- These survive morphological close and render as dots when Martin tiles are simplified.

CREATE OR REPLACE FUNCTION gis.drop_small_holes(g geometry, min_area_m2 double precision DEFAULT 50000)
RETURNS geometry(MultiPolygon, 4326) AS $$
DECLARE
  part geometry;
  i int;
  kept geometry[];
  built geometry[];
BEGIN
  IF g IS NULL OR ST_IsEmpty(g) THEN
    RETURN ST_SetSRID(ST_Multi(g), 4326)::geometry(MultiPolygon, 4326);
  END IF;

  FOR part IN SELECT (ST_Dump(g)).geom LOOP
  CONTINUE WHEN ST_GeometryType(part) <> 'ST_Polygon';

    kept := ARRAY[ST_ExteriorRing(part)];
    FOR i IN 1..ST_NumInteriorRings(part) LOOP
      IF ST_Area(ST_InteriorRingN(part, i)::geography) >= min_area_m2 THEN
        kept := kept || ST_InteriorRingN(part, i);
      END IF;
    END LOOP;

    IF array_length(kept, 1) = 1 THEN
      built := built || ST_MakePolygon(kept[1]);
    ELSE
      built := built || ST_MakePolygon(kept[1], kept[2:array_length(kept, 1)]);
    END IF;
  END LOOP;

  IF built IS NULL OR array_length(built, 1) IS NULL THEN
    RETURN ST_SetSRID(ST_Multi(g), 4326)::geometry(MultiPolygon, 4326);
  END IF;
  IF array_length(built, 1) = 1 THEN
    RETURN ST_SetSRID(ST_Multi(built[1]), 4326)::geometry(MultiPolygon, 4326);
  END IF;
  RETURN ST_SetSRID(ST_Multi(ST_Collect(built)), 4326)::geometry(MultiPolygon, 4326);
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION gis.ensure_boundary_overview_view(
  p_detail_schema TEXT,
  p_detail_table TEXT,
  p_overview_name TEXT,
  p_dissolve_column TEXT,
  p_close_meters DOUBLE PRECISION DEFAULT 25
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
    'CREATE VIEW %I.%I AS
     SELECT
       (row_number() OVER (ORDER BY %I))::int4 AS fid,
       %I::text AS %I,
       gis.drop_small_holes(
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
         )::geometry(MultiPolygon, 4326),
         50000
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
  EXECUTE format('DROP VIEW IF EXISTS %I.%I', p_detail_schema, p_overview_name);
  EXECUTE v_sql;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION gis.drop_small_holes(geometry, double precision) TO service_role;
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
