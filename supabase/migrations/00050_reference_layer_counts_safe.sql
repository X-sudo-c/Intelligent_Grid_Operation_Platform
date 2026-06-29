-- refresh_reference_layer_counts: skip missing gis.* tables (fresh DB without GPKG).

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
    BEGIN
      v_sql := format(
        'SELECT COUNT(*) FROM %I.%I',
        rec.target_schema,
        rec.target_table
      );
      EXECUTE v_sql INTO v_count;
      UPDATE gis.reference_layers
      SET feature_count = v_count, updated_at = NOW()
      WHERE slug = rec.slug;
    EXCEPTION
      WHEN undefined_table THEN
        UPDATE gis.reference_layers
        SET feature_count = 0, updated_at = NOW()
        WHERE slug = rec.slug;
    END;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
