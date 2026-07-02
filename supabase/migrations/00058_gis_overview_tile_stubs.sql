-- Empty stubs for the raw GIS overview layers published by config/martin.yaml.
--
-- These tables are normally created by the GIS import (ogr2ogr -overwrite of
-- Power System.gpkg). On a fresh / pre-import database they do not exist, so
-- Martin returns HTTP 500 ("relation does not exist") for every tile request.
-- MapLibre then crashes during symbol placement (continuePlacement -> reading
-- 'get' of undefined) when a fly-to loads those tiles, which freezes the map.
--
-- Creating empty stubs makes Martin serve valid empty (204) tiles instead of
-- 500s. The import still replaces them via ogr2ogr -overwrite when real data
-- arrives, so this is forward-compatible.

CREATE SCHEMA IF NOT EXISTS gis;

CREATE TABLE IF NOT EXISTS gis.power_transformer (geom geometry(Geometry, 4326));
CREATE TABLE IF NOT EXISTS gis.distribution_transformer (geom geometry(Geometry, 4326));
CREATE TABLE IF NOT EXISTS gis.oh_conductor_11kv (geom geometry(Geometry, 4326));
CREATE TABLE IF NOT EXISTS gis.oh_conductor_33kv (geom geometry(Geometry, 4326));
CREATE TABLE IF NOT EXISTS gis.ug_cable_11kv (geom geometry(Geometry, 4326));
CREATE TABLE IF NOT EXISTS gis.ug_cable_33kv (geom geometry(Geometry, 4326));

CREATE INDEX IF NOT EXISTS idx_gis_power_transformer_geom ON gis.power_transformer USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_gis_distribution_transformer_geom ON gis.distribution_transformer USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_gis_oh_conductor_11kv_geom ON gis.oh_conductor_11kv USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_gis_oh_conductor_33kv_geom ON gis.oh_conductor_33kv USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_gis_ug_cable_11kv_geom ON gis.ug_cable_11kv USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_gis_ug_cable_33kv_geom ON gis.ug_cable_33kv USING GIST (geom);
