-- Fix slow rebuild_unique_id_lookup: remove O(conductors × poles) proximity cartesian join
-- from the default promote path. Branch + district lookup remain; proximity is optional.

CREATE INDEX IF NOT EXISTS idx_district_endpoint_lookup_geom
  ON gis.district_endpoint_lookup USING GIST (geom);

CREATE INDEX IF NOT EXISTS idx_district_endpoint_lookup_district
  ON gis.district_endpoint_lookup (district);

CREATE INDEX IF NOT EXISTS idx_conductor_segments_district_layer
  ON gis.conductor_segments (district, source_layer)
  WHERE district IS NOT NULL AND btrim(district) <> '';

-- Fast alias rebuild (branch naming only) — runs during promote_topology.sh.
CREATE OR REPLACE FUNCTION gis.rebuild_endpoint_id_aliases()
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = gis, public
AS $$
DECLARE
  v_branch BIGINT := 0;
BEGIN
  TRUNCATE gis.endpoint_id_alias;

  INSERT INTO gis.endpoint_id_alias (district, alias, canonical, alias_kind)
  SELECT DISTINCT
    btrim(p.district),
    parts.p1 || '/' || parts.p2,
    btrim(p.unique_id),
    'branch_segment_omit'
  FROM (
    SELECT district, btrim(unique_id) AS unique_id
    FROM gis.oh_support_structure_11kv
    WHERE unique_id ~ '^P[0-9]+/1/.+' AND district IS NOT NULL AND btrim(district) <> ''
    UNION ALL
    SELECT district, btrim(unique_id)
    FROM gis.oh_support_structure_33kv
    WHERE unique_id ~ '^P[0-9]+/1/.+' AND district IS NOT NULL AND btrim(district) <> ''
    UNION ALL
    SELECT district, btrim(unique_id)
    FROM gis.oh_support_structure_lvle
    WHERE unique_id ~ '^P[0-9]+/1/.+' AND district IS NOT NULL AND btrim(district) <> ''
  ) p
  CROSS JOIN LATERAL (
    SELECT (regexp_match(p.unique_id, '^(P[0-9]+)/1/(.*)$'))[1] AS p1,
           (regexp_match(p.unique_id, '^(P[0-9]+)/1/(.*)$'))[2] AS p2
  ) parts
  WHERE parts.p1 IS NOT NULL
    AND parts.p2 IS NOT NULL
    AND btrim(parts.p2) <> ''
    AND EXISTS (
      SELECT 1 FROM gis.district_endpoint_lookup l
      WHERE l.district = btrim(p.district) AND l.unique_id = p.unique_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM gis.district_endpoint_lookup l
      WHERE l.district = btrim(p.district) AND l.unique_id = parts.p1 || '/' || parts.p2
    )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_branch = ROW_COUNT;

  RETURN jsonb_build_object(
    'endpoint_alias_rows', (SELECT COUNT(*) FROM gis.endpoint_id_alias),
    'branch_segment_omit', v_branch,
    'geometry_proximity', 0,
    'geometry_proximity_skipped', true
  );
END;
$$;

-- Optional slow pass: index-friendly nearest-pole within 3m (run separately, not in promote).
CREATE OR REPLACE FUNCTION gis.rebuild_geometry_proximity_aliases(
  p_max_dist_m DOUBLE PRECISION DEFAULT 3.0
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = gis, public
AS $$
DECLARE
  v_end BIGINT := 0;
  v_start BIGINT := 0;
BEGIN
  INSERT INTO gis.endpoint_id_alias (district, alias, canonical, alias_kind)
  SELECT DISTINCT ON (btrim(cs.district), btrim(cs.end_node_id))
    btrim(cs.district),
    btrim(cs.end_node_id),
    btrim(near.unique_id),
    'geometry_proximity'
  FROM gis.conductor_segments cs
  CROSS JOIN LATERAL (
    SELECT ST_EndPoint(gis.as_linestring(cs.geom))::geography AS ep
  ) ep
  CROSS JOIN LATERAL (
    SELECT COUNT(*)::int AS hits
    FROM gis.district_endpoint_lookup p
    WHERE p.district = btrim(cs.district)
      AND ST_DWithin(ep.ep, p.geom::geography, p_max_dist_m)
  ) hit
  CROSS JOIN LATERAL (
    SELECT p.unique_id
    FROM gis.district_endpoint_lookup p
    WHERE p.district = btrim(cs.district)
      AND ST_DWithin(ep.ep, p.geom::geography, p_max_dist_m)
    ORDER BY p.geom::geography <-> ep.ep
    LIMIT 1
  ) near
  WHERE cs.district IS NOT NULL AND btrim(cs.district) <> ''
    AND cs.end_node_id IS NOT NULL AND btrim(cs.end_node_id) <> ''
    AND cs.source_layer IN ('oh_conductor_11kv', 'oh_conductor_33kv', 'ug_cable_11kv', 'ug_cable_33kv')
    AND gis.as_linestring(cs.geom) IS NOT NULL
    AND NOT gis.endpoint_is_resolved(cs.district, cs.end_node_id)
    AND btrim(near.unique_id) <> btrim(cs.end_node_id)
    AND hit.hits = 1
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_end = ROW_COUNT;

  INSERT INTO gis.endpoint_id_alias (district, alias, canonical, alias_kind)
  SELECT DISTINCT ON (btrim(cs.district), btrim(cs.originating_node_id))
    btrim(cs.district),
    btrim(cs.originating_node_id),
    btrim(near.unique_id),
    'geometry_proximity'
  FROM gis.conductor_segments cs
  CROSS JOIN LATERAL (
    SELECT ST_StartPoint(gis.as_linestring(cs.geom))::geography AS ep
  ) ep
  CROSS JOIN LATERAL (
    SELECT COUNT(*)::int AS hits
    FROM gis.district_endpoint_lookup p
    WHERE p.district = btrim(cs.district)
      AND ST_DWithin(ep.ep, p.geom::geography, p_max_dist_m)
  ) hit
  CROSS JOIN LATERAL (
    SELECT p.unique_id
    FROM gis.district_endpoint_lookup p
    WHERE p.district = btrim(cs.district)
      AND ST_DWithin(ep.ep, p.geom::geography, p_max_dist_m)
    ORDER BY p.geom::geography <-> ep.ep
    LIMIT 1
  ) near
  WHERE cs.district IS NOT NULL AND btrim(cs.district) <> ''
    AND cs.originating_node_id IS NOT NULL AND btrim(cs.originating_node_id) <> ''
    AND cs.source_layer IN ('oh_conductor_11kv', 'oh_conductor_33kv', 'ug_cable_11kv', 'ug_cable_33kv')
    AND gis.as_linestring(cs.geom) IS NOT NULL
    AND NOT gis.endpoint_is_resolved(cs.district, cs.originating_node_id)
    AND btrim(near.unique_id) <> btrim(cs.originating_node_id)
    AND hit.hits = 1
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_start = ROW_COUNT;

  RETURN jsonb_build_object(
    'geometry_proximity_end', v_end,
    'geometry_proximity_start', v_start,
    'endpoint_alias_rows', (SELECT COUNT(*) FROM gis.endpoint_id_alias)
  );
END;
$$;

COMMENT ON FUNCTION gis.rebuild_geometry_proximity_aliases IS
  'Optional slow pass: infer pole ID aliases from line endpoint geometry (3m). Run outside promote_topology.sh.';

GRANT EXECUTE ON FUNCTION gis.rebuild_geometry_proximity_aliases(DOUBLE PRECISION) TO service_role;
