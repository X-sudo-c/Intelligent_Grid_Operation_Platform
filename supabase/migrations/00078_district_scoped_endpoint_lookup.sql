-- District-scoped endpoint lookup: disambiguates reused pole IDs (P1, P2, …) per district.
-- Also adds conservative geometry-proximity aliases for MV conductors.

CREATE TABLE IF NOT EXISTS gis.district_endpoint_lookup (
  district TEXT NOT NULL,
  unique_id TEXT NOT NULL,
  mrid UUID NOT NULL,
  geom GEOMETRY(Point, 4326),
  PRIMARY KEY (district, unique_id)
);

CREATE INDEX IF NOT EXISTS idx_district_endpoint_lookup_mrid
  ON gis.district_endpoint_lookup (mrid);

CREATE INDEX IF NOT EXISTS idx_district_endpoint_lookup_uid
  ON gis.district_endpoint_lookup (unique_id);

-- endpoint_id_alias: add district scope (truncate small alias set; rebuilt on promote).
ALTER TABLE gis.endpoint_id_alias
  ADD COLUMN IF NOT EXISTS district TEXT;

TRUNCATE gis.endpoint_id_alias;

ALTER TABLE gis.endpoint_id_alias
  ALTER COLUMN district SET NOT NULL;

ALTER TABLE gis.endpoint_id_alias
  DROP CONSTRAINT IF EXISTS endpoint_id_alias_pkey;

ALTER TABLE gis.endpoint_id_alias
  ADD PRIMARY KEY (district, alias);

-- Resolve pole/transformer endpoint: district lookup first, then global fallback.
CREATE OR REPLACE FUNCTION gis.resolve_endpoint(
  p_district TEXT,
  p_uid TEXT
)
RETURNS TABLE(mrid UUID, geom GEOMETRY(Point, 4326))
LANGUAGE plpgsql
STABLE
SET search_path = gis, public
AS $$
DECLARE
  v_district TEXT := NULLIF(btrim(p_district), '');
  v_uid TEXT := NULLIF(btrim(p_uid), '');
BEGIN
  IF v_uid IS NULL THEN
    RETURN;
  END IF;

  IF v_district IS NOT NULL THEN
    RETURN QUERY
    SELECT l.mrid, l.geom
    FROM gis.district_endpoint_lookup l
    WHERE l.district = v_district AND l.unique_id = v_uid
    LIMIT 1;
    IF FOUND THEN
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  SELECT u.mrid, u.geom
  FROM gis.unique_id_lookup u
  WHERE u.unique_id = v_uid
  LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION gis.endpoint_is_resolved(p_district TEXT, p_uid TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = gis, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM gis.resolve_endpoint(p_district, p_uid) r WHERE r.mrid IS NOT NULL
  );
$$;

CREATE OR REPLACE FUNCTION gis.rebuild_district_endpoint_lookup()
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = gis, public
AS $$
DECLARE
  v_rows BIGINT;
BEGIN
  TRUNCATE gis.district_endpoint_lookup;

  INSERT INTO gis.district_endpoint_lookup (district, unique_id, mrid, geom)
  SELECT DISTINCT ON (btrim(p.district), btrim(p.unique_id))
    btrim(p.district),
    btrim(p.unique_id),
    gis.mrid_from_source(gis.source_asset_key(p.layer_name, p.fid)),
    gis.as_point(p.geom)
  FROM (
    SELECT 'oh_support_structure_11kv'::text AS layer_name, fid, unique_id, district, geom
    FROM gis.oh_support_structure_11kv
    WHERE geom IS NOT NULL
      AND district IS NOT NULL AND btrim(district) <> ''
      AND unique_id IS NOT NULL AND btrim(unique_id) <> ''
    UNION ALL
    SELECT 'oh_support_structure_33kv', fid, unique_id, district, geom
    FROM gis.oh_support_structure_33kv
    WHERE geom IS NOT NULL
      AND district IS NOT NULL AND btrim(district) <> ''
      AND unique_id IS NOT NULL AND btrim(unique_id) <> ''
    UNION ALL
    SELECT 'oh_support_structure_lvle', fid, unique_id, district, geom
    FROM gis.oh_support_structure_lvle
    WHERE geom IS NOT NULL
      AND district IS NOT NULL AND btrim(district) <> ''
      AND unique_id IS NOT NULL AND btrim(unique_id) <> ''
    UNION ALL
    SELECT 'distribution_transformer', fid, unique_id, district, geom
    FROM gis.distribution_transformer
    WHERE geom IS NOT NULL
      AND district IS NOT NULL AND btrim(district) <> ''
      AND unique_id IS NOT NULL AND btrim(unique_id) <> ''
    UNION ALL
    SELECT 'power_transformer', fid, unique_id, district, geom
    FROM gis.power_transformer
    WHERE geom IS NOT NULL
      AND district IS NOT NULL AND btrim(district) <> ''
      AND unique_id IS NOT NULL AND btrim(unique_id) <> ''
  ) p
  ORDER BY
    btrim(p.district),
    btrim(p.unique_id),
    CASE p.layer_name
      WHEN 'distribution_transformer' THEN 1
      WHEN 'power_transformer' THEN 2
      WHEN 'oh_support_structure_11kv' THEN 3
      WHEN 'oh_support_structure_33kv' THEN 4
      WHEN 'oh_support_structure_lvle' THEN 5
      ELSE 9
    END,
    p.fid;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  RETURN jsonb_build_object('district_endpoint_lookup_rows', v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION gis.rebuild_endpoint_id_aliases()
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = gis, public
AS $$
DECLARE
  v_branch BIGINT := 0;
  v_prox_end BIGINT := 0;
  v_prox_start BIGINT := 0;
BEGIN
  TRUNCATE gis.endpoint_id_alias;

  -- P107/1/b23/6 -> alias P107/b23/6 within the same district.
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

  -- MV conductors: if stated end ID fails but line end is within 3m of exactly one
  -- district pole with a different ID, register a geometry-proximity alias.
  INSERT INTO gis.endpoint_id_alias (district, alias, canonical, alias_kind)
  SELECT DISTINCT ON (district, alias)
    district,
    alias,
    canonical,
    'geometry_proximity'
  FROM (
    SELECT
      btrim(cs.district) AS district,
      btrim(cs.end_node_id) AS alias,
      btrim(p.unique_id) AS canonical,
      ST_Distance(
        ST_EndPoint(gis.as_linestring(cs.geom))::geography,
        p.geom::geography
      ) AS dist_m,
      COUNT(*) OVER (PARTITION BY cs.id) AS pole_hits
    FROM gis.conductor_segments cs
    JOIN gis.district_endpoint_lookup p
      ON p.district = btrim(cs.district)
    WHERE cs.district IS NOT NULL AND btrim(cs.district) <> ''
      AND cs.end_node_id IS NOT NULL AND btrim(cs.end_node_id) <> ''
      AND cs.source_layer IN ('oh_conductor_11kv', 'oh_conductor_33kv', 'ug_cable_11kv', 'ug_cable_33kv')
      AND gis.as_linestring(cs.geom) IS NOT NULL
      AND NOT gis.endpoint_is_resolved(cs.district, cs.end_node_id)
      AND btrim(p.unique_id) <> btrim(cs.end_node_id)
      AND ST_DWithin(
        ST_EndPoint(gis.as_linestring(cs.geom))::geography,
        p.geom::geography,
        3.0
      )
  ) prox
  WHERE prox.dist_m <= 3.0 AND prox.pole_hits = 1
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_prox_end = ROW_COUNT;

  -- Same for originating (start) IDs on MV layers.
  INSERT INTO gis.endpoint_id_alias (district, alias, canonical, alias_kind)
  SELECT DISTINCT ON (district, alias)
    district,
    alias,
    canonical,
    'geometry_proximity'
  FROM (
    SELECT
      btrim(cs.district) AS district,
      btrim(cs.originating_node_id) AS alias,
      btrim(p.unique_id) AS canonical,
      ST_Distance(
        ST_StartPoint(gis.as_linestring(cs.geom))::geography,
        p.geom::geography
      ) AS dist_m,
      COUNT(*) OVER (PARTITION BY cs.id) AS pole_hits
    FROM gis.conductor_segments cs
    JOIN gis.district_endpoint_lookup p
      ON p.district = btrim(cs.district)
    WHERE cs.district IS NOT NULL AND btrim(cs.district) <> ''
      AND cs.originating_node_id IS NOT NULL AND btrim(cs.originating_node_id) <> ''
      AND cs.source_layer IN ('oh_conductor_11kv', 'oh_conductor_33kv', 'ug_cable_11kv', 'ug_cable_33kv')
      AND gis.as_linestring(cs.geom) IS NOT NULL
      AND NOT gis.endpoint_is_resolved(cs.district, cs.originating_node_id)
      AND btrim(p.unique_id) <> btrim(cs.originating_node_id)
      AND ST_DWithin(
        ST_StartPoint(gis.as_linestring(cs.geom))::geography,
        p.geom::geography,
        3.0
      )
  ) prox
  WHERE prox.dist_m <= 3.0 AND prox.pole_hits = 1
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_prox_start = ROW_COUNT;

  RETURN jsonb_build_object(
    'endpoint_alias_rows', (SELECT COUNT(*) FROM gis.endpoint_id_alias),
    'branch_segment_omit', v_branch,
    'geometry_proximity', v_prox_end + v_prox_start
  );
END;
$$;

CREATE OR REPLACE FUNCTION gis.merge_endpoint_aliases_into_lookups()
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = gis, public
AS $$
DECLARE
  v_district BIGINT := 0;
BEGIN
  INSERT INTO gis.district_endpoint_lookup (district, unique_id, mrid, geom)
  SELECT a.district, a.alias, l.mrid, l.geom
  FROM gis.endpoint_id_alias a
  JOIN gis.district_endpoint_lookup l
    ON l.district = a.district AND l.unique_id = a.canonical
  ON CONFLICT (district, unique_id) DO NOTHING;

  GET DIAGNOSTICS v_district = ROW_COUNT;

  RETURN jsonb_build_object('district_alias_rows_merged', v_district);
END;
$$;

CREATE OR REPLACE FUNCTION gis.rebuild_unique_id_lookup()
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = gis, public
AS $$
DECLARE
  v_canonical BIGINT;
  v_district JSONB;
  v_alias JSONB;
  v_merge JSONB;
BEGIN
  TRUNCATE gis.unique_id_lookup;

  INSERT INTO gis.unique_id_lookup (unique_id, mrid, geom)
  SELECT DISTINCT ON (btrim(source_unique_id))
    btrim(source_unique_id),
    mrid,
    geom
  FROM gis.asset_id_map
  WHERE source_unique_id IS NOT NULL AND btrim(source_unique_id) <> ''
  ORDER BY
    btrim(source_unique_id),
    CASE source_layer
      WHEN 'distribution_transformer' THEN 1
      WHEN 'power_transformer' THEN 2
      WHEN 'oh_support_structure_11kv' THEN 3
      WHEN 'oh_support_structure_33kv' THEN 4
      WHEN 'oh_support_structure_lvle' THEN 5
      ELSE 9
    END,
    source_fid;

  GET DIAGNOSTICS v_canonical = ROW_COUNT;

  v_district := gis.rebuild_district_endpoint_lookup();
  v_alias := gis.rebuild_endpoint_id_aliases();
  v_merge := gis.merge_endpoint_aliases_into_lookups();

  RETURN jsonb_build_object(
    'unique_id_lookup_rows', (SELECT COUNT(*) FROM gis.unique_id_lookup),
    'canonical_lookup_rows', v_canonical,
    'district_endpoint_lookup', v_district,
    'endpoint_aliases', v_alias,
    'alias_merge', v_merge,
    'district_endpoint_lookup_rows', (SELECT COUNT(*) FROM gis.district_endpoint_lookup)
  );
END;
$$;

-- Recreate import status MV with district-aware resolution.
DROP MATERIALIZED VIEW IF EXISTS gis.conductor_import_status;

CREATE MATERIALIZED VIEW gis.conductor_import_status AS
SELECT
  cs.id,
  cs.source_layer,
  cs.source_fid,
  cs.voltage_class,
  cs.circuit_id,
  cs.district,
  cs.region,
  cs.originating_node_id,
  cs.end_node_id,
  cs.length_m,
  ST_X(ST_Centroid(cs.geom)) AS longitude,
  ST_Y(ST_Centroid(cs.geom)) AS latitude,
  gis.conductor_segment_mrid(cs.source_layer, cs.source_fid)::text AS line_mrid,
  CASE
    WHEN cs.originating_node_id IS NULL
      OR cs.end_node_id IS NULL
      OR btrim(cs.originating_node_id) = ''
      OR btrim(cs.end_node_id) = ''
    THEN 'missing_endpoints'
    WHEN NOT gis.endpoint_is_resolved(cs.district, cs.originating_node_id) THEN 'unresolved_originating'
    WHEN NOT gis.endpoint_is_resolved(cs.district, cs.end_node_id) THEN 'unresolved_end'
    WHEN (SELECT r.mrid FROM gis.resolve_endpoint(cs.district, cs.originating_node_id) r LIMIT 1)
       = (SELECT r.mrid FROM gis.resolve_endpoint(cs.district, cs.end_node_id) r LIMIT 1)
    THEN 'same_endpoint'
    WHEN cs.geom IS NULL
      OR GeometryType(ST_Force2D(cs.geom)) NOT IN ('LINESTRING', 'MULTILINESTRING')
    THEN 'invalid_geom'
    WHEN als.mrid IS NOT NULL THEN 'already_promoted'
    ELSE 'eligible_unpromoted'
  END AS reason
FROM gis.conductor_segments cs
LEFT JOIN public.ac_line_segments als
  ON als.mrid = gis.conductor_segment_mrid(cs.source_layer, cs.source_fid)
WITH NO DATA;

CREATE UNIQUE INDEX idx_gis_conductor_import_status_id
  ON gis.conductor_import_status (id);

CREATE INDEX idx_gis_conductor_import_status_reason
  ON gis.conductor_import_status (reason);

CREATE INDEX idx_gis_conductor_import_status_district_reason
  ON gis.conductor_import_status (district, reason)
  WHERE district IS NOT NULL AND btrim(district) <> '';

-- Snap + promote: district-aware endpoint joins.
CREATE OR REPLACE FUNCTION gis.snap_eligible_conductor_endpoints(
  p_tolerance_m DOUBLE PRECISION DEFAULT 1.0,
  p_max_move_m DOUBLE PRECISION DEFAULT 150.0
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = gis, public
AS $$
DECLARE
  v_snapped BIGINT := 0;
  v_already_aligned BIGINT := 0;
  v_no_geom BIGINT := 0;
  v_unresolved BIGINT := 0;
  v_span_rejected BIGINT := 0;
  v_move_rejected BIGINT := 0;
BEGIN
  DROP TABLE IF EXISTS _snap_classified;
  CREATE TEMP TABLE _snap_classified ON COMMIT DROP AS
  WITH resolved AS (
    SELECT
      cs.id,
      cs.voltage_class,
      src.geom AS src_geom,
      tgt.geom AS tgt_geom,
      gis.as_linestring(cs.geom) AS raw_line,
      ST_Distance(src.geom::geography, tgt.geom::geography) AS span_m
    FROM gis.conductor_segments cs
    INNER JOIN LATERAL gis.resolve_endpoint(cs.district, cs.originating_node_id) src ON src.mrid IS NOT NULL
    INNER JOIN LATERAL gis.resolve_endpoint(cs.district, cs.end_node_id) tgt ON tgt.mrid IS NOT NULL
    WHERE cs.originating_node_id IS NOT NULL
      AND cs.end_node_id IS NOT NULL
      AND btrim(cs.originating_node_id) <> ''
      AND btrim(cs.end_node_id) <> ''
      AND src.mrid IS DISTINCT FROM tgt.mrid
  ),
  oriented AS (
    SELECT
      r.*,
      CASE
        WHEN r.raw_line IS NULL THEN NULL
        WHEN ST_Distance(ST_StartPoint(r.raw_line)::geography, r.src_geom::geography)
           + ST_Distance(ST_EndPoint(r.raw_line)::geography, r.tgt_geom::geography)
          <= ST_Distance(ST_StartPoint(r.raw_line)::geography, r.tgt_geom::geography)
           + ST_Distance(ST_EndPoint(r.raw_line)::geography, r.src_geom::geography)
        THEN r.raw_line
        ELSE ST_Reverse(r.raw_line)
      END AS line_geom
    FROM resolved r
  ),
  measured AS (
    SELECT
      o.*,
      CASE WHEN o.line_geom IS NULL THEN NULL
        ELSE ST_Distance(ST_StartPoint(o.line_geom)::geography, o.src_geom::geography)
      END AS start_move_m,
      CASE WHEN o.line_geom IS NULL THEN NULL
        ELSE ST_Distance(ST_EndPoint(o.line_geom)::geography, o.tgt_geom::geography)
      END AS end_move_m
    FROM oriented o
  )
  SELECT
    m.id,
    CASE
      WHEN m.line_geom IS NULL THEN NULL
      ELSE ST_SetPoint(
             ST_SetPoint(m.line_geom, 0, m.src_geom),
             ST_NPoints(m.line_geom) - 1,
             m.tgt_geom
           )
    END AS snapped_geom,
    CASE
      WHEN m.line_geom IS NULL THEN 'no_geom'
      WHEN m.span_m > gis.max_conductor_snap_span_m(m.voltage_class) THEN 'span_rejected'
      WHEN m.start_move_m <= p_tolerance_m AND m.end_move_m <= p_tolerance_m THEN 'aligned'
      WHEN m.start_move_m > p_max_move_m OR m.end_move_m > p_max_move_m THEN 'move_rejected'
      ELSE 'snap'
    END AS action
  FROM measured m;

  UPDATE gis.conductor_segments cs
  SET geom = c.snapped_geom
  FROM _snap_classified c
  WHERE cs.id = c.id
    AND c.action = 'snap'
    AND c.snapped_geom IS NOT NULL;

  GET DIAGNOSTICS v_snapped = ROW_COUNT;

  SELECT
    COUNT(*) FILTER (WHERE action = 'aligned'),
    COUNT(*) FILTER (WHERE action = 'no_geom'),
    COUNT(*) FILTER (WHERE action = 'span_rejected'),
    COUNT(*) FILTER (WHERE action = 'move_rejected')
  INTO v_already_aligned, v_no_geom, v_span_rejected, v_move_rejected
  FROM _snap_classified;

  SELECT COUNT(*) INTO v_unresolved
  FROM gis.conductor_segments cs
  WHERE cs.originating_node_id IS NULL
     OR cs.end_node_id IS NULL
     OR btrim(cs.originating_node_id) = ''
     OR btrim(cs.end_node_id) = ''
     OR NOT gis.endpoint_is_resolved(cs.district, cs.originating_node_id)
     OR NOT gis.endpoint_is_resolved(cs.district, cs.end_node_id)
     OR (
       (SELECT r.mrid FROM gis.resolve_endpoint(cs.district, cs.originating_node_id) r LIMIT 1)
       = (SELECT r.mrid FROM gis.resolve_endpoint(cs.district, cs.end_node_id) r LIMIT 1)
     );

  DROP TABLE IF EXISTS _snap_classified;

  RETURN jsonb_build_object(
    'segments_snapped', v_snapped,
    'segments_already_aligned', v_already_aligned,
    'segments_no_geom', v_no_geom,
    'segments_unresolved', v_unresolved,
    'segments_span_rejected', v_span_rejected,
    'segments_move_rejected', v_move_rejected,
    'tolerance_m', p_tolerance_m,
    'max_move_m', p_max_move_m
  );
END;
$$;

CREATE OR REPLACE FUNCTION gis.promote_conductors_to_cim()
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = gis, public
AS $$
DECLARE
  v_lines BIGINT;
  v_skipped BIGINT;
  v_unresolved BIGINT;
BEGIN
  DROP TABLE IF EXISTS _gis_eligible_conductors;
  ALTER TABLE public.ac_line_segments DISABLE TRIGGER trg_webhook_ac_line_segments;

  CREATE TEMP TABLE _gis_eligible_conductors ON COMMIT DROP AS
  SELECT
    cs.id,
    cs.source_layer,
    cs.source_fid,
    cs.voltage_class,
    cs.circuit_id,
    gis.conductor_segment_mrid(cs.source_layer, cs.source_fid) AS line_mrid,
    src.mrid AS source_mrid,
    tgt.mrid AS target_mrid,
    gis.as_linestring(cs.geom) AS line_geom
  FROM gis.conductor_segments cs
  INNER JOIN LATERAL gis.resolve_endpoint(cs.district, cs.originating_node_id) src ON src.mrid IS NOT NULL
  INNER JOIN LATERAL gis.resolve_endpoint(cs.district, cs.end_node_id) tgt ON tgt.mrid IS NOT NULL
  WHERE cs.originating_node_id IS NOT NULL
    AND cs.end_node_id IS NOT NULL
    AND btrim(cs.originating_node_id) <> ''
    AND btrim(cs.end_node_id) <> ''
    AND src.mrid IS DISTINCT FROM tgt.mrid
    AND gis.as_linestring(cs.geom) IS NOT NULL
    AND ST_Distance(src.geom::geography, tgt.geom::geography)
        <= gis.max_conductor_snap_span_m(cs.voltage_class)
    AND ST_Length(gis.as_linestring(cs.geom)::geography)
        <= gis.max_conductor_snap_span_m(cs.voltage_class);

  INSERT INTO public.identified_objects (mrid, name, lifecycle_state, validation)
  SELECT e.line_mrid, e.source_layer || ' segment ' || e.source_fid::text, 'IN_SERVICE', 'APPROVED'
  FROM _gis_eligible_conductors e
  ON CONFLICT (mrid) DO NOTHING;

  INSERT INTO public.conducting_equipment (mrid, phases, nominal_voltage, serial_number)
  SELECT e.line_mrid, 'ABC', gis.voltage_class_to_enum(e.voltage_class), NULLIF(btrim(e.circuit_id), '')
  FROM _gis_eligible_conductors e
  ON CONFLICT (mrid) DO NOTHING;

  INSERT INTO public.ac_line_segments (mrid, source_node_id, target_node_id, direction_downstream, geom)
  SELECT e.line_mrid, e.source_mrid, e.target_mrid, TRUE, e.line_geom::geometry(LineString, 4326)
  FROM _gis_eligible_conductors e
  WHERE GeometryType(e.line_geom) = 'LINESTRING'
  ON CONFLICT (mrid) DO UPDATE SET
    source_node_id = EXCLUDED.source_node_id,
    target_node_id = EXCLUDED.target_node_id,
    geom = EXCLUDED.geom;

  GET DIAGNOSTICS v_lines = ROW_COUNT;
  ALTER TABLE public.ac_line_segments ENABLE TRIGGER trg_webhook_ac_line_segments;

  SELECT COUNT(*) INTO v_skipped
  FROM gis.conductor_segments cs
  WHERE cs.originating_node_id IS NULL OR cs.end_node_id IS NULL
     OR btrim(cs.originating_node_id) = '' OR btrim(cs.end_node_id) = '';

  SELECT COUNT(*) INTO v_unresolved
  FROM gis.conductor_segments cs
  WHERE cs.originating_node_id IS NOT NULL AND cs.end_node_id IS NOT NULL
    AND btrim(cs.originating_node_id) <> '' AND btrim(cs.end_node_id) <> ''
    AND NOT EXISTS (SELECT 1 FROM _gis_eligible_conductors e WHERE e.id = cs.id);

  RETURN jsonb_build_object(
    'ac_line_segments_inserted', v_lines,
    'segments_missing_endpoints', v_skipped,
    'segments_unresolved_endpoints', v_unresolved
  );
END;
$$;

GRANT SELECT ON gis.district_endpoint_lookup TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION gis.resolve_endpoint(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gis.endpoint_is_resolved(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gis.rebuild_district_endpoint_lookup() TO service_role;
GRANT EXECUTE ON FUNCTION gis.merge_endpoint_aliases_into_lookups() TO service_role;
