-- Re-enable GIS network overview catalog rows when gis.* tables have data.
-- Migration 00056 deactivated all network rows; the map probe gates Martin overview layers on this catalog.

CREATE OR REPLACE FUNCTION gis.sync_network_reference_catalog()
RETURNS JSONB AS $$
DECLARE
  rec RECORD;
  v_count BIGINT;
  v_sql TEXT;
  v_activated INT := 0;
  v_deactivated INT := 0;
BEGIN
  FOR rec IN
    SELECT slug, target_schema, target_table
    FROM gis.reference_layers
    WHERE kind = 'network'
      AND target_table IS NOT NULL
  LOOP
    BEGIN
      v_sql := format('SELECT COUNT(*)::bigint FROM %I.%I', rec.target_schema, rec.target_table);
      EXECUTE v_sql INTO v_count;
    EXCEPTION
      WHEN undefined_table THEN
        v_count := 0;
    END;

    IF v_count > 0 THEN
      UPDATE gis.reference_layers
      SET active = TRUE,
          feature_count = v_count,
          render_mode = 'martin',
          last_imported_at = COALESCE(last_imported_at, NOW()),
          updated_at = NOW()
      WHERE slug = rec.slug;
      v_activated := v_activated + 1;
    ELSE
      UPDATE gis.reference_layers
      SET active = FALSE,
          feature_count = 0,
          render_mode = 'none',
          updated_at = NOW()
      WHERE slug = rec.slug;
      v_deactivated := v_deactivated + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'activated', v_activated,
    'deactivated', v_deactivated
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION gis.sync_network_reference_catalog IS
  'Sync gis.reference_layers network rows with live gis.* table counts (map overview probe).';

GRANT EXECUTE ON FUNCTION gis.sync_network_reference_catalog() TO service_role;

SELECT gis.sync_network_reference_catalog();

-- Keep catalog in sync after GPKG import / conductor rebuild.
CREATE OR REPLACE FUNCTION gis.post_import_refresh()
RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'asset_id_map', gis.rebuild_asset_id_map(),
    'conductors', gis.rebuild_conductor_segments(),
    'unique_id_lookup', gis.rebuild_unique_id_lookup(),
    'conductor_snap', gis.snap_eligible_conductor_endpoints(),
    'cim_nodes', gis.promote_transformers_to_cim(),
    'import_status', gis.refresh_conductor_import_status(),
    'network_catalog', gis.sync_network_reference_catalog()
  );
$$ LANGUAGE sql;
