-- Reclassify LV/service customer-meter endpoint labels out of unresolved_* buckets.
-- Stewards see ~271k "Customer meter" ends as expected service drops, not pole lookup failures.

CREATE OR REPLACE FUNCTION gis.is_customer_equipment_id(p_uid TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = gis, public
AS $$
  SELECT CASE
    WHEN NULLIF(btrim(p_uid), '') IS NULL THEN FALSE
    ELSE btrim(p_uid) ~* '(meter|customer|premises|service|breaker|consumer)'
  END;
$$;

COMMENT ON FUNCTION gis.is_customer_equipment_id IS
  'True when conductor endpoint text is a customer/service label (not a pole unique_id).';

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

  IF gis.is_customer_equipment_id(v) THEN
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

-- Optional meter layer: include in district lookup when gis.customer_meter_lvle exists.
CREATE OR REPLACE FUNCTION gis.rebuild_district_endpoint_lookup()
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = gis, public
AS $$
DECLARE
  v_rows BIGINT;
  v_meter_rows BIGINT := 0;
  v_has_meters BOOLEAN;
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

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'gis' AND table_name = 'customer_meter_lvle'
  ) INTO v_has_meters;

  IF v_has_meters THEN
    INSERT INTO gis.district_endpoint_lookup (district, unique_id, mrid, geom)
    SELECT DISTINCT ON (btrim(m.district), btrim(m.unique_id))
      btrim(m.district),
      btrim(m.unique_id),
      gis.mrid_from_source(gis.source_asset_key('customer_meter_lvle', m.fid)),
      gis.as_point(m.geom)
    FROM gis.customer_meter_lvle m
    WHERE m.geom IS NOT NULL
      AND m.district IS NOT NULL AND btrim(m.district) <> ''
      AND m.unique_id IS NOT NULL AND btrim(m.unique_id) <> ''
    ORDER BY
      btrim(m.district),
      btrim(m.unique_id),
      m.fid
    ON CONFLICT DO NOTHING;

    GET DIAGNOSTICS v_meter_rows = ROW_COUNT;
    v_rows := v_rows + v_meter_rows;
  END IF;

  RETURN jsonb_build_object(
    'district_endpoint_lookup_rows', v_rows,
    'customer_meter_rows', v_meter_rows,
    'customer_meter_layer_present', v_has_meters
  );
END;
$$;

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
    WHEN gis.is_customer_equipment_id(cs.originating_node_id)
      AND NOT gis.endpoint_is_resolved(cs.district, cs.originating_node_id)
    THEN 'customer_equipment_originating'
    WHEN gis.is_customer_equipment_id(cs.end_node_id)
      AND NOT gis.endpoint_is_resolved(cs.district, cs.end_node_id)
    THEN 'customer_equipment_end'
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
    SELECT gis.classify_endpoint_id(u.originating_node_id) AS cls
    FROM unpromoted u
  ),
  ends AS (
    SELECT gis.classify_endpoint_id(u.end_node_id) AS cls
    FROM unpromoted u
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
    SELECT gis.classify_endpoint_id(u.end_node_id) AS cls
    FROM unpromoted u
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

GRANT EXECUTE ON FUNCTION gis.is_customer_equipment_id(TEXT) TO service_role;
