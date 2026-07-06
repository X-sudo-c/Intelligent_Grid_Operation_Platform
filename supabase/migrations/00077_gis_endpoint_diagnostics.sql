-- Endpoint ID diagnostics + alias normalization (QGIS GPKG naming fixes).

CREATE TABLE IF NOT EXISTS gis.endpoint_id_alias (
  alias TEXT PRIMARY KEY,
  canonical TEXT NOT NULL,
  alias_kind TEXT NOT NULL DEFAULT 'branch_segment_omit',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gis_endpoint_id_alias_canonical
  ON gis.endpoint_id_alias (canonical);

COMMENT ON TABLE gis.endpoint_id_alias IS
  'Alternate conductor endpoint strings mapped to canonical pole unique_id rows (e.g. P107/b23/6 -> P107/1/b23/6).';

-- Classify a raw endpoint string for steward diagnostics.
CREATE OR REPLACE FUNCTION gis.classify_endpoint_id(p_uid TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = gis, public
AS $$
DECLARE
  v TEXT := NULLIF(btrim(p_uid), '');
BEGIN
  IF v IS NULL THEN
    RETURN 'missing';
  END IF;

  IF EXISTS (SELECT 1 FROM gis.unique_id_lookup u WHERE u.unique_id = v) THEN
    RETURN 'pole_resolved';
  END IF;

  IF EXISTS (SELECT 1 FROM gis.endpoint_id_alias a WHERE a.alias = v) THEN
    RETURN 'pole_alias_pending';
  END IF;

  IF v ~* '(meter|customer|premises|service|breaker|consumer)' THEN
    RETURN 'customer_equipment';
  END IF;

  IF v ~ '^P[0-9]+$' OR length(v) <= 4 THEN
    RETURN 'generic_short_id';
  END IF;

  IF v ~ '^P[0-9]+/' OR v ~ '^[A-Za-z]+[0-9]+/' THEN
    RETURN 'pole_id_unmatched';
  END IF;

  RETURN 'other_unmatched';
END;
$$;

COMMENT ON FUNCTION gis.classify_endpoint_id IS
  'Steward-facing endpoint bucket: pole_resolved, customer_equipment, generic_short_id, pole_id_unmatched, etc.';

-- Register conductor-style aliases for poles stored with an extra branch segment (/1/).
CREATE OR REPLACE FUNCTION gis.rebuild_endpoint_id_aliases()
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = gis, public
AS $$
DECLARE
  v_rows BIGINT;
BEGIN
  TRUNCATE gis.endpoint_id_alias;

  INSERT INTO gis.endpoint_id_alias (alias, canonical, alias_kind)
  SELECT DISTINCT
    parts.p1 || '/' || parts.p2,
    p.unique_id,
    'branch_segment_omit'
  FROM (
    SELECT btrim(unique_id) AS unique_id
    FROM gis.oh_support_structure_11kv
    WHERE unique_id IS NOT NULL AND btrim(unique_id) ~ '^P[0-9]+/1/.+'
    UNION ALL
    SELECT btrim(unique_id)
    FROM gis.oh_support_structure_33kv
    WHERE unique_id IS NOT NULL AND btrim(unique_id) ~ '^P[0-9]+/1/.+'
    UNION ALL
    SELECT btrim(unique_id)
    FROM gis.oh_support_structure_lvle
    WHERE unique_id IS NOT NULL AND btrim(unique_id) ~ '^P[0-9]+/1/.+'
  ) p
  CROSS JOIN LATERAL (
    SELECT (regexp_match(p.unique_id, '^(P[0-9]+)/1/(.*)$'))[1] AS p1,
           (regexp_match(p.unique_id, '^(P[0-9]+)/1/(.*)$'))[2] AS p2
  ) parts
  WHERE parts.p1 IS NOT NULL
    AND parts.p2 IS NOT NULL
    AND btrim(parts.p2) <> ''
    AND EXISTS (
      SELECT 1 FROM gis.unique_id_lookup u WHERE u.unique_id = p.unique_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM gis.unique_id_lookup u WHERE u.unique_id = parts.p1 || '/' || parts.p2
    )
  ON CONFLICT (alias) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  RETURN jsonb_build_object(
    'endpoint_alias_rows', v_rows,
    'endpoint_alias_distinct', (SELECT COUNT(*) FROM gis.endpoint_id_alias)
  );
END;
$$;

-- Extend lookup rebuild: canonical asset IDs, then merge alias strings.
CREATE OR REPLACE FUNCTION gis.rebuild_unique_id_lookup()
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = gis, public
AS $$
DECLARE
  v_canonical BIGINT;
  v_alias_merged BIGINT;
  v_alias_meta JSONB;
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

  v_alias_meta := gis.rebuild_endpoint_id_aliases();

  INSERT INTO gis.unique_id_lookup (unique_id, mrid, geom)
  SELECT a.alias, u.mrid, u.geom
  FROM gis.endpoint_id_alias a
  JOIN gis.unique_id_lookup u ON u.unique_id = a.canonical
  ON CONFLICT (unique_id) DO NOTHING;

  GET DIAGNOSTICS v_alias_merged = ROW_COUNT;

  RETURN jsonb_build_object(
    'unique_id_lookup_rows', (SELECT COUNT(*) FROM gis.unique_id_lookup),
    'canonical_lookup_rows', v_canonical,
    'alias_rows_merged', v_alias_merged,
    'endpoint_aliases', v_alias_meta
  );
END;
$$;

-- Aggregate endpoint classes for unpromoted conductor segments (steward queue insight).
CREATE OR REPLACE FUNCTION gis.endpoint_diagnostics_summary(
  p_district TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = gis, public
AS $$
DECLARE
  v_orig JSONB;
  v_end JSONB;
  v_total BIGINT;
  v_district TEXT := NULLIF(btrim(p_district), '');
BEGIN
  SELECT COUNT(*) INTO v_total
  FROM gis.conductor_import_status s
  WHERE s.reason <> 'already_promoted'
    AND (v_district IS NULL OR s.district = v_district);

  WITH unpromoted AS (
    SELECT s.originating_node_id, s.end_node_id
    FROM gis.conductor_import_status s
    WHERE s.reason <> 'already_promoted'
      AND (v_district IS NULL OR s.district = v_district)
  ),
  orig AS (
    SELECT
      CASE
        WHEN u.originating_node_id IS NULL OR btrim(u.originating_node_id) = '' THEN 'missing'
        WHEN l.unique_id IS NOT NULL THEN 'pole_resolved'
        WHEN a.alias IS NOT NULL THEN 'pole_alias_pending'
        WHEN btrim(u.originating_node_id) ~* '(meter|customer|premises|service|breaker|consumer)' THEN 'customer_equipment'
        WHEN btrim(u.originating_node_id) ~ '^P[0-9]+$' OR length(btrim(u.originating_node_id)) <= 4 THEN 'generic_short_id'
        WHEN btrim(u.originating_node_id) ~ '^P[0-9]+/' OR btrim(u.originating_node_id) ~ '^[A-Za-z]+[0-9]+/' THEN 'pole_id_unmatched'
        ELSE 'other_unmatched'
      END AS cls
    FROM unpromoted u
    LEFT JOIN gis.unique_id_lookup l ON l.unique_id = btrim(u.originating_node_id)
    LEFT JOIN gis.endpoint_id_alias a ON a.alias = btrim(u.originating_node_id)
  ),
  ends AS (
    SELECT
      CASE
        WHEN u.end_node_id IS NULL OR btrim(u.end_node_id) = '' THEN 'missing'
        WHEN l.unique_id IS NOT NULL THEN 'pole_resolved'
        WHEN a.alias IS NOT NULL THEN 'pole_alias_pending'
        WHEN btrim(u.end_node_id) ~* '(meter|customer|premises|service|breaker|consumer)' THEN 'customer_equipment'
        WHEN btrim(u.end_node_id) ~ '^P[0-9]+$' OR length(btrim(u.end_node_id)) <= 4 THEN 'generic_short_id'
        WHEN btrim(u.end_node_id) ~ '^P[0-9]+/' OR btrim(u.end_node_id) ~ '^[A-Za-z]+[0-9]+/' THEN 'pole_id_unmatched'
        ELSE 'other_unmatched'
      END AS cls
    FROM unpromoted u
    LEFT JOIN gis.unique_id_lookup l ON l.unique_id = btrim(u.end_node_id)
    LEFT JOIN gis.endpoint_id_alias a ON a.alias = btrim(u.end_node_id)
  )
  SELECT COALESCE(jsonb_object_agg(cls, cnt ORDER BY cnt DESC), '{}'::jsonb)
  INTO v_orig
  FROM (SELECT cls, COUNT(*)::bigint AS cnt FROM orig GROUP BY 1) x;

  WITH unpromoted AS (
    SELECT s.end_node_id
    FROM gis.conductor_import_status s
    WHERE s.reason <> 'already_promoted'
      AND (v_district IS NULL OR s.district = v_district)
  ),
  ends AS (
    SELECT
      CASE
        WHEN u.end_node_id IS NULL OR btrim(u.end_node_id) = '' THEN 'missing'
        WHEN l.unique_id IS NOT NULL THEN 'pole_resolved'
        WHEN a.alias IS NOT NULL THEN 'pole_alias_pending'
        WHEN btrim(u.end_node_id) ~* '(meter|customer|premises|service|breaker|consumer)' THEN 'customer_equipment'
        WHEN btrim(u.end_node_id) ~ '^P[0-9]+$' OR length(btrim(u.end_node_id)) <= 4 THEN 'generic_short_id'
        WHEN btrim(u.end_node_id) ~ '^P[0-9]+/' OR btrim(u.end_node_id) ~ '^[A-Za-z]+[0-9]+/' THEN 'pole_id_unmatched'
        ELSE 'other_unmatched'
      END AS cls
    FROM unpromoted u
    LEFT JOIN gis.unique_id_lookup l ON l.unique_id = btrim(u.end_node_id)
    LEFT JOIN gis.endpoint_id_alias a ON a.alias = btrim(u.end_node_id)
  )
  SELECT COALESCE(jsonb_object_agg(cls, cnt ORDER BY cnt DESC), '{}'::jsonb)
  INTO v_end
  FROM (SELECT cls, COUNT(*)::bigint AS cnt FROM ends GROUP BY 1) x;

  RETURN jsonb_build_object(
    'unpromoted_segments', v_total,
    'district', v_district,
    'originating', v_orig,
    'end', v_end,
    'endpoint_alias_rows', (SELECT COUNT(*) FROM gis.endpoint_id_alias),
    'lookup_rows', (SELECT COUNT(*) FROM gis.unique_id_lookup),
    'refreshed_at', NOW()
  );
END;
$$;

GRANT SELECT ON gis.endpoint_id_alias TO service_role;
GRANT EXECUTE ON FUNCTION gis.classify_endpoint_id(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION gis.rebuild_endpoint_id_aliases() TO service_role;
GRANT EXECUTE ON FUNCTION gis.rebuild_unique_id_lookup() TO service_role;
GRANT EXECUTE ON FUNCTION gis.endpoint_diagnostics_summary(TEXT) TO service_role;
