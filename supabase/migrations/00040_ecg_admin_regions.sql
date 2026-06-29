-- Region-level ECG admin boundaries for low-zoom map tiles (one polygon + label per region).
-- District detail remains on gis.ecg_admin_boundaries for zoom >= 10.

CREATE OR REPLACE VIEW gis.ecg_admin_regions AS
SELECT
  (row_number() OVER (ORDER BY region))::int4 AS fid,
  region,
  ST_Multi(ST_Union(geom))::geometry(MultiPolygon, 4326) AS geom
FROM gis.ecg_admin_boundaries
WHERE region IS NOT NULL AND btrim(region) <> ''
GROUP BY region;

COMMENT ON VIEW gis.ecg_admin_regions IS
  'Martin map layer: ECG regions as dissolved district unions for country/regional zoom.';
