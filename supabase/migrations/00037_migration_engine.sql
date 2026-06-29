-- FR-017: migration adapter (GeoPackage / DXF) — run registry, failed elements, commit helper.

CREATE TABLE IF NOT EXISTS gis.migration_runs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_format   TEXT NOT NULL,                 -- 'dxf' | 'geopackage'
  source_name     TEXT,
  status          TEXT NOT NULL DEFAULT 'running',
  feature_count   BIGINT NOT NULL DEFAULT 0,
  committed_count BIGINT NOT NULL DEFAULT 0,
  failed_count    BIGINT NOT NULL DEFAULT 0,
  params          JSONB,
  requested_by    TEXT,
  error_summary   TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_gis_migration_runs_started
  ON gis.migration_runs (started_at DESC);

-- "Migration failed elements" registry (FR-002 data model item).
CREATE TABLE IF NOT EXISTS gis.migration_failed_elements (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id        UUID REFERENCES gis.migration_runs (id) ON DELETE CASCADE,
  source_ref    TEXT,
  primitive     TEXT,
  raw_payload   JSONB,
  error_message TEXT NOT NULL,
  dlq_id        UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gis_migration_failed_run
  ON gis.migration_failed_elements (run_id, created_at DESC);

-- Commit one migrated POINT as a staging connectivity node (goes through DQ + approve).
CREATE OR REPLACE FUNCTION gis.commit_migration_node(
  p_mrid        UUID,
  p_name        TEXT,
  p_lon         DOUBLE PRECISION,
  p_lat         DOUBLE PRECISION,
  p_feeder      TEXT DEFAULT NULL,
  p_utility     TEXT DEFAULT 'ECG_SOUTHERN',
  p_substation  TEXT DEFAULT NULL,
  p_submitted_by TEXT DEFAULT 'migration'
)
RETURNS BOOLEAN AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM staging.identified_objects WHERE mrid = p_mrid)
     OR EXISTS (SELECT 1 FROM public.identified_objects WHERE mrid = p_mrid) THEN
    RETURN FALSE;
  END IF;

  INSERT INTO staging.identified_objects (mrid, name, lifecycle_state, validation, submitted_by)
  VALUES (p_mrid, p_name, 'IN_SERVICE', 'PENDING_FIELD', p_submitted_by);

  INSERT INTO staging.connectivity_nodes (mrid, boundary_feeder_id, geom)
  VALUES (p_mrid, p_feeder, ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326));

  INSERT INTO staging.ghana_grid_assets (mrid, operating_utility, substation_name)
  VALUES (p_mrid, p_utility::ghana_utility_enum, COALESCE(p_substation, p_name));

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Commit one migrated LINE into the raw conductor registry (promoted later via gis.promote_*).
CREATE OR REPLACE FUNCTION gis.commit_migration_line(
  p_source_layer TEXT,
  p_source_fid   BIGINT,
  p_wkt          TEXT,
  p_voltage      TEXT DEFAULT NULL,
  p_circuit      TEXT DEFAULT NULL
)
RETURNS BIGINT AS $$
DECLARE
  v_id BIGINT;
BEGIN
  INSERT INTO gis.conductor_segments (
    source_layer, source_fid, voltage_class, circuit_id, geom, length_m
  )
  VALUES (
    p_source_layer, p_source_fid, p_voltage, p_circuit,
    ST_SetSRID(ST_GeomFromText(p_wkt), 4326),
    ST_Length(ST_SetSRID(ST_GeomFromText(p_wkt), 4326)::geography)
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

GRANT SELECT, INSERT, UPDATE ON gis.migration_runs TO service_role, authenticated;
GRANT SELECT, INSERT ON gis.migration_failed_elements TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION gis.commit_migration_node(UUID, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gis.commit_migration_line(TEXT, BIGINT, TEXT, TEXT, TEXT) TO service_role;
