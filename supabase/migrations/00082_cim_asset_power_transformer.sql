-- CIM Asset / AssetInfo + PowerTransformer equipment (IEC 61970/61968 aligned master model).

CREATE TABLE IF NOT EXISTS public.cim_assets (
  mrid UUID PRIMARY KEY REFERENCES public.identified_objects (mrid) ON DELETE CASCADE,
  equipment_mrid UUID NOT NULL,
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('power_transformer', 'distribution_transformer', 'ac_line_segment')),
  UNIQUE (equipment_mrid)
);

CREATE INDEX IF NOT EXISTS idx_cim_assets_equipment ON public.cim_assets (equipment_mrid);

CREATE TABLE IF NOT EXISTS public.cim_asset_info (
  mrid UUID PRIMARY KEY REFERENCES public.identified_objects (mrid) ON DELETE CASCADE,
  asset_mrid UUID NOT NULL REFERENCES public.cim_assets (mrid) ON DELETE CASCADE,
  info_kind TEXT NOT NULL CHECK (info_kind IN ('PowerTransformerInfo', 'ACLineSegmentInfo')),
  manufacturer TEXT,
  model_number TEXT,
  serial_number TEXT,
  rated_power_kva DOUBLE PRECISION,
  year_of_manufacture INTEGER,
  source_layer TEXT,
  source_fid BIGINT
);

CREATE INDEX IF NOT EXISTS idx_cim_asset_info_asset ON public.cim_asset_info (asset_mrid);

CREATE TABLE IF NOT EXISTS public.power_transformers (
  mrid UUID PRIMARY KEY REFERENCES public.conducting_equipment (mrid) ON DELETE CASCADE,
  connectivity_node_mrid UUID NOT NULL REFERENCES public.connectivity_nodes (mrid),
  transformer_kind TEXT NOT NULL CHECK (transformer_kind IN ('power', 'distribution')),
  rated_power_kva DOUBLE PRECISION,
  vector_group TEXT,
  substation_name TEXT,
  UNIQUE (connectivity_node_mrid)
);

CREATE INDEX IF NOT EXISTS idx_power_transformers_cn ON public.power_transformers (connectivity_node_mrid);

COMMENT ON TABLE public.power_transformers IS
  'CIM PowerTransformer equipment; connectivity_node_mrid is the map/topology node at the transformer location.';
COMMENT ON TABLE public.cim_assets IS
  'CIM Asset registry linking physical asset records to conducting equipment MRIDs.';
COMMENT ON TABLE public.cim_asset_info IS
  'CIM AssetInfo catalogue data (manufacturer, ratings) for interchange exports.';

CREATE OR REPLACE FUNCTION gis.transformer_equipment_mrid(p_layer TEXT, p_fid BIGINT)
RETURNS UUID AS $$
  SELECT gis.mrid_from_source('pt-equipment:' || gis.source_asset_key(p_layer, p_fid));
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION gis.transformer_asset_mrid(p_layer TEXT, p_fid BIGINT)
RETURNS UUID AS $$
  SELECT gis.mrid_from_source('pt-asset:' || gis.source_asset_key(p_layer, p_fid));
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION gis.transformer_asset_info_mrid(p_layer TEXT, p_fid BIGINT)
RETURNS UUID AS $$
  SELECT gis.mrid_from_source('pt-asset-info:' || gis.source_asset_key(p_layer, p_fid));
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION gis.transformer_nominal_voltage(p_layer TEXT)
RETURNS ghana_voltage_enum AS $$
  SELECT CASE p_layer
    WHEN 'power_transformer' THEN 'MV_33KV'::ghana_voltage_enum
    WHEN 'distribution_transformer' THEN 'MV_11KV'::ghana_voltage_enum
    ELSE 'MV_11KV'::ghana_voltage_enum
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION gis.promote_transformers_to_cim()
RETURNS JSONB AS $$
DECLARE
  v_dist BIGINT := 0;
  v_pwr BIGINT := 0;
  v_equipment BIGINT := 0;
BEGIN
  -- Distribution transformers -------------------------------------------------
  INSERT INTO public.identified_objects (mrid, name, lifecycle_state, validation)
  SELECT
    gis.mrid_from_source(gis.source_asset_key('distribution_transformer', dt.fid)),
    COALESCE(NULLIF(btrim(dt.asset_name), ''), 'DT ' || COALESCE(NULLIF(btrim(dt.unique_id), ''), dt.fid::text)),
    'IN_SERVICE',
    'APPROVED'
  FROM gis.distribution_transformer dt
  WHERE dt.geom IS NOT NULL
  ON CONFLICT (mrid) DO NOTHING;

  INSERT INTO public.connectivity_nodes (mrid, boundary_feeder_id, geom)
  SELECT
    gis.mrid_from_source(gis.source_asset_key('distribution_transformer', dt.fid)),
    NULLIF(btrim(dt.circuit_id), ''),
    gis.as_point(dt.geom)
  FROM gis.distribution_transformer dt
  WHERE dt.geom IS NOT NULL
  ON CONFLICT (mrid) DO NOTHING;

  GET DIAGNOSTICS v_dist = ROW_COUNT;

  INSERT INTO public.ghana_grid_assets (mrid, operating_utility, substation_name)
  SELECT
    gis.mrid_from_source(gis.source_asset_key('distribution_transformer', dt.fid)),
    'ECG_SOUTHERN',
    NULLIF(btrim(dt.district), '')
  FROM gis.distribution_transformer dt
  WHERE dt.geom IS NOT NULL
  ON CONFLICT (mrid) DO NOTHING;

  WITH src AS (
    SELECT
      dt.fid,
      gis.mrid_from_source(gis.source_asset_key('distribution_transformer', dt.fid)) AS node_mrid,
      gis.transformer_equipment_mrid('distribution_transformer', dt.fid) AS equipment_mrid,
      gis.transformer_asset_mrid('distribution_transformer', dt.fid) AS asset_mrid,
      gis.transformer_asset_info_mrid('distribution_transformer', dt.fid) AS asset_info_mrid,
      COALESCE(NULLIF(btrim(dt.asset_name), ''), 'DT ' || COALESCE(NULLIF(btrim(dt.unique_id), ''), dt.fid::text)) AS eq_name,
      COALESCE(NULLIF(btrim(dt.manufacturer), ''), NULLIF(btrim(dt.other_manufacturer), '')) AS manufacturer,
      NULLIF(btrim(dt.manufacturer_model_number), '') AS model_number,
      NULLIF(btrim(dt.serial_number), '') AS serial_number,
      dt.rated_power_kva,
      dt.year_manufacture AS year_of_manufacture,
      COALESCE(NULLIF(btrim(dt.vector_group), ''), NULLIF(btrim(dt.other_vector_group), '')) AS vector_group,
      NULLIF(btrim(dt.district), '') AS substation_name
    FROM gis.distribution_transformer dt
    WHERE dt.geom IS NOT NULL
  )
  INSERT INTO public.identified_objects (mrid, name, lifecycle_state, validation)
  SELECT s.equipment_mrid, s.eq_name, 'IN_SERVICE', 'APPROVED' FROM src s
  ON CONFLICT (mrid) DO NOTHING;

  WITH src AS (
    SELECT
      dt.fid,
      gis.transformer_equipment_mrid('distribution_transformer', dt.fid) AS equipment_mrid,
      COALESCE(NULLIF(btrim(dt.asset_name), ''), 'DT ' || COALESCE(NULLIF(btrim(dt.unique_id), ''), dt.fid::text)) AS eq_name,
      dt.rated_power_kva,
      dt.year_manufacture AS year_of_manufacture,
      COALESCE(NULLIF(btrim(dt.vector_group), ''), NULLIF(btrim(dt.other_vector_group), '')) AS vector_group,
      NULLIF(btrim(dt.district), '') AS substation_name
    FROM gis.distribution_transformer dt
    WHERE dt.geom IS NOT NULL
  )
  INSERT INTO public.conducting_equipment (mrid, phases, nominal_voltage, serial_number)
  SELECT s.equipment_mrid, 'ABC', gis.transformer_nominal_voltage('distribution_transformer'), NULL
  FROM src s
  ON CONFLICT (mrid) DO NOTHING;

  WITH src AS (
    SELECT
      gis.transformer_equipment_mrid('distribution_transformer', dt.fid) AS equipment_mrid,
      gis.mrid_from_source(gis.source_asset_key('distribution_transformer', dt.fid)) AS node_mrid,
      dt.rated_power_kva,
      COALESCE(NULLIF(btrim(dt.vector_group), ''), NULLIF(btrim(dt.other_vector_group), '')) AS vector_group,
      NULLIF(btrim(dt.district), '') AS substation_name
    FROM gis.distribution_transformer dt
    WHERE dt.geom IS NOT NULL
  )
  INSERT INTO public.power_transformers (mrid, connectivity_node_mrid, transformer_kind, rated_power_kva, vector_group, substation_name)
  SELECT s.equipment_mrid, s.node_mrid, 'distribution', s.rated_power_kva, s.vector_group, s.substation_name
  FROM src s
  ON CONFLICT (mrid) DO UPDATE SET
    rated_power_kva = EXCLUDED.rated_power_kva,
    vector_group = EXCLUDED.vector_group,
    substation_name = EXCLUDED.substation_name;

  WITH src AS (
    SELECT
      gis.transformer_asset_mrid('distribution_transformer', dt.fid) AS asset_mrid,
      gis.transformer_equipment_mrid('distribution_transformer', dt.fid) AS equipment_mrid,
      COALESCE(NULLIF(btrim(dt.asset_name), ''), 'Asset DT ' || COALESCE(NULLIF(btrim(dt.unique_id), ''), dt.fid::text)) AS asset_name
    FROM gis.distribution_transformer dt
    WHERE dt.geom IS NOT NULL
  )
  INSERT INTO public.identified_objects (mrid, name, lifecycle_state, validation)
  SELECT s.asset_mrid, s.asset_name, 'IN_SERVICE', 'APPROVED' FROM src s
  ON CONFLICT (mrid) DO NOTHING;

  WITH src AS (
    SELECT
      gis.transformer_asset_mrid('distribution_transformer', dt.fid) AS asset_mrid,
      gis.transformer_equipment_mrid('distribution_transformer', dt.fid) AS equipment_mrid
    FROM gis.distribution_transformer dt
    WHERE dt.geom IS NOT NULL
  )
  INSERT INTO public.cim_assets (mrid, equipment_mrid, asset_kind)
  SELECT s.asset_mrid, s.equipment_mrid, 'distribution_transformer'
  FROM src s
  ON CONFLICT (equipment_mrid) DO UPDATE SET asset_kind = EXCLUDED.asset_kind;

  WITH src AS (
    SELECT
      gis.transformer_asset_info_mrid('distribution_transformer', dt.fid) AS asset_info_mrid,
      gis.transformer_asset_mrid('distribution_transformer', dt.fid) AS asset_mrid,
      COALESCE(NULLIF(btrim(dt.manufacturer), ''), NULLIF(btrim(dt.other_manufacturer), '')) AS manufacturer,
      NULLIF(btrim(dt.manufacturer_model_number), '') AS model_number,
      NULLIF(btrim(dt.serial_number), '') AS serial_number,
      dt.rated_power_kva,
      dt.year_manufacture AS year_of_manufacture,
      dt.fid
    FROM gis.distribution_transformer dt
    WHERE dt.geom IS NOT NULL
  )
  INSERT INTO public.identified_objects (mrid, name, lifecycle_state, validation)
  SELECT s.asset_info_mrid, 'DT AssetInfo ' || s.fid::text, 'IN_SERVICE', 'APPROVED' FROM src s
  ON CONFLICT (mrid) DO NOTHING;

  WITH src AS (
    SELECT
      gis.transformer_asset_info_mrid('distribution_transformer', dt.fid) AS asset_info_mrid,
      gis.transformer_asset_mrid('distribution_transformer', dt.fid) AS asset_mrid,
      COALESCE(NULLIF(btrim(dt.manufacturer), ''), NULLIF(btrim(dt.other_manufacturer), '')) AS manufacturer,
      NULLIF(btrim(dt.manufacturer_model_number), '') AS model_number,
      NULLIF(btrim(dt.serial_number), '') AS serial_number,
      dt.rated_power_kva,
      dt.year_manufacture AS year_of_manufacture,
      dt.fid
    FROM gis.distribution_transformer dt
    WHERE dt.geom IS NOT NULL
  )
  INSERT INTO public.cim_asset_info (
    mrid, asset_mrid, info_kind, manufacturer, model_number, serial_number,
    rated_power_kva, year_of_manufacture, source_layer, source_fid
  )
  SELECT
    s.asset_info_mrid, s.asset_mrid, 'PowerTransformerInfo',
    s.manufacturer, s.model_number, s.serial_number,
    s.rated_power_kva, s.year_of_manufacture, 'distribution_transformer', s.fid
  FROM src s
  ON CONFLICT (mrid) DO UPDATE SET
    manufacturer = EXCLUDED.manufacturer,
    model_number = EXCLUDED.model_number,
    serial_number = EXCLUDED.serial_number,
    rated_power_kva = EXCLUDED.rated_power_kva,
    year_of_manufacture = EXCLUDED.year_of_manufacture;

  -- Power transformers --------------------------------------------------------
  INSERT INTO public.identified_objects (mrid, name, lifecycle_state, validation)
  SELECT
    gis.mrid_from_source(gis.source_asset_key('power_transformer', pt.fid)),
    COALESCE(NULLIF(btrim(pt.asset_name), ''), 'PT ' || COALESCE(NULLIF(btrim(pt.unique_id), ''), pt.fid::text)),
    'IN_SERVICE',
    'APPROVED'
  FROM gis.power_transformer pt
  WHERE pt.geom IS NOT NULL
  ON CONFLICT (mrid) DO NOTHING;

  INSERT INTO public.connectivity_nodes (mrid, boundary_feeder_id, geom)
  SELECT
    gis.mrid_from_source(gis.source_asset_key('power_transformer', pt.fid)),
    NULLIF(btrim(pt.circuit_id), ''),
    gis.as_point(pt.geom)
  FROM gis.power_transformer pt
  WHERE pt.geom IS NOT NULL
  ON CONFLICT (mrid) DO NOTHING;

  GET DIAGNOSTICS v_pwr = ROW_COUNT;

  INSERT INTO public.ghana_grid_assets (mrid, operating_utility, substation_name)
  SELECT
    gis.mrid_from_source(gis.source_asset_key('power_transformer', pt.fid)),
    'ECG_SOUTHERN',
    COALESCE(NULLIF(btrim(pt.substation_name), ''), NULLIF(btrim(pt.district), ''))
  FROM gis.power_transformer pt
  WHERE pt.geom IS NOT NULL
  ON CONFLICT (mrid) DO NOTHING;

  WITH src AS (
    SELECT
      pt.fid,
      gis.transformer_equipment_mrid('power_transformer', pt.fid) AS equipment_mrid,
      COALESCE(NULLIF(btrim(pt.asset_name), ''), 'PT ' || COALESCE(NULLIF(btrim(pt.unique_id), ''), pt.fid::text)) AS eq_name
    FROM gis.power_transformer pt
    WHERE pt.geom IS NOT NULL
  )
  INSERT INTO public.identified_objects (mrid, name, lifecycle_state, validation)
  SELECT s.equipment_mrid, s.eq_name, 'IN_SERVICE', 'APPROVED' FROM src s
  ON CONFLICT (mrid) DO NOTHING;

  WITH src AS (
    SELECT
      gis.transformer_equipment_mrid('power_transformer', pt.fid) AS equipment_mrid,
      gis.mrid_from_source(gis.source_asset_key('power_transformer', pt.fid)) AS node_mrid,
      pt.rated_power AS rated_power_kva,
      NULLIF(btrim(pt.vector_group), '') AS vector_group,
      COALESCE(NULLIF(btrim(pt.substation_name), ''), NULLIF(btrim(pt.district), '')) AS substation_name
    FROM gis.power_transformer pt
    WHERE pt.geom IS NOT NULL
  )
  INSERT INTO public.conducting_equipment (mrid, phases, nominal_voltage, serial_number)
  SELECT s.equipment_mrid, 'ABC', gis.transformer_nominal_voltage('power_transformer'), NULL
  FROM src s
  ON CONFLICT (mrid) DO NOTHING;

  WITH src AS (
    SELECT
      gis.transformer_equipment_mrid('power_transformer', pt.fid) AS equipment_mrid,
      gis.mrid_from_source(gis.source_asset_key('power_transformer', pt.fid)) AS node_mrid,
      pt.rated_power AS rated_power_kva,
      NULLIF(btrim(pt.vector_group), '') AS vector_group,
      COALESCE(NULLIF(btrim(pt.substation_name), ''), NULLIF(btrim(pt.district), '')) AS substation_name
    FROM gis.power_transformer pt
    WHERE pt.geom IS NOT NULL
  )
  INSERT INTO public.power_transformers (mrid, connectivity_node_mrid, transformer_kind, rated_power_kva, vector_group, substation_name)
  SELECT s.equipment_mrid, s.node_mrid, 'power', s.rated_power_kva, s.vector_group, s.substation_name
  FROM src s
  ON CONFLICT (mrid) DO UPDATE SET
    rated_power_kva = EXCLUDED.rated_power_kva,
    vector_group = EXCLUDED.vector_group,
    substation_name = EXCLUDED.substation_name;

  GET DIAGNOSTICS v_equipment = ROW_COUNT;

  WITH src AS (
    SELECT
      gis.transformer_asset_mrid('power_transformer', pt.fid) AS asset_mrid,
      gis.transformer_equipment_mrid('power_transformer', pt.fid) AS equipment_mrid,
      COALESCE(NULLIF(btrim(pt.asset_name), ''), 'Asset PT ' || COALESCE(NULLIF(btrim(pt.unique_id), ''), pt.fid::text)) AS asset_name
    FROM gis.power_transformer pt
    WHERE pt.geom IS NOT NULL
  )
  INSERT INTO public.identified_objects (mrid, name, lifecycle_state, validation)
  SELECT s.asset_mrid, s.asset_name, 'IN_SERVICE', 'APPROVED' FROM src s
  ON CONFLICT (mrid) DO NOTHING;

  WITH src AS (
    SELECT
      gis.transformer_asset_mrid('power_transformer', pt.fid) AS asset_mrid,
      gis.transformer_equipment_mrid('power_transformer', pt.fid) AS equipment_mrid
    FROM gis.power_transformer pt
    WHERE pt.geom IS NOT NULL
  )
  INSERT INTO public.cim_assets (mrid, equipment_mrid, asset_kind)
  SELECT s.asset_mrid, s.equipment_mrid, 'power_transformer'
  FROM src s
  ON CONFLICT (equipment_mrid) DO UPDATE SET asset_kind = EXCLUDED.asset_kind;

  WITH src AS (
    SELECT
      gis.transformer_asset_info_mrid('power_transformer', pt.fid) AS asset_info_mrid,
      gis.transformer_asset_mrid('power_transformer', pt.fid) AS asset_mrid,
      pt.fid
    FROM gis.power_transformer pt
    WHERE pt.geom IS NOT NULL
  )
  INSERT INTO public.identified_objects (mrid, name, lifecycle_state, validation)
  SELECT s.asset_info_mrid, 'PT AssetInfo ' || s.fid::text, 'IN_SERVICE', 'APPROVED' FROM src s
  ON CONFLICT (mrid) DO NOTHING;

  WITH src AS (
    SELECT
      gis.transformer_asset_info_mrid('power_transformer', pt.fid) AS asset_info_mrid,
      gis.transformer_asset_mrid('power_transformer', pt.fid) AS asset_mrid,
      COALESCE(NULLIF(btrim(pt.manufacturer), ''), NULLIF(btrim(pt.other_manufacturer), '')) AS manufacturer,
      NULLIF(btrim(pt.manufacturer_model_number), '') AS model_number,
      NULLIF(btrim(pt.serial_number), '') AS serial_number,
      pt.rated_power AS rated_power_kva,
      pt.year_of_manufacture,
      pt.fid
    FROM gis.power_transformer pt
    WHERE pt.geom IS NOT NULL
  )
  INSERT INTO public.cim_asset_info (
    mrid, asset_mrid, info_kind, manufacturer, model_number, serial_number,
    rated_power_kva, year_of_manufacture, source_layer, source_fid
  )
  SELECT
    s.asset_info_mrid, s.asset_mrid, 'PowerTransformerInfo',
    s.manufacturer, s.model_number, s.serial_number,
    s.rated_power_kva, s.year_of_manufacture, 'power_transformer', s.fid
  FROM src s
  ON CONFLICT (mrid) DO UPDATE SET
    manufacturer = EXCLUDED.manufacturer,
    model_number = EXCLUDED.model_number,
    serial_number = EXCLUDED.serial_number,
    rated_power_kva = EXCLUDED.rated_power_kva,
    year_of_manufacture = EXCLUDED.year_of_manufacture;

  RETURN jsonb_build_object(
    'distribution_transformer_nodes', v_dist,
    'power_transformer_nodes', v_pwr,
    'power_transformer_equipment', v_equipment
  );
END;
$$ LANGUAGE plpgsql;

-- Extend mapping register for interchange documentation.
INSERT INTO public.cim_mapping_register (
  canonical_object, cim_class, cim_profile, local_schema, local_field,
  transformation_rule, owner
) VALUES
  ('PowerTransformer', 'PowerTransformer', 'IEC61970-452', 'public', 'power_transformers.mrid',
   'ConductingEquipment extension; Terminal links to connectivity_node_mrid', 'GIS'),
  ('PowerTransformer', 'PowerTransformer', 'IEC61970-452', 'public', 'power_transformers.rated_power_kva',
   'Maps to PowerTransformerInfo / ratedS when AssetInfo present', 'GIS'),
  ('Asset', 'Asset', 'IEC61968', 'public', 'cim_assets.mrid',
   'Physical asset registry; Asset.PowerSystemResources → equipment_mrid', 'GIS'),
  ('AssetInfo', 'PowerTransformerInfo', 'IEC61968', 'public', 'cim_asset_info.manufacturer',
   'Manufacturer catalogue field from GIS import', 'GIS'),
  ('AssetInfo', 'PowerTransformerInfo', 'IEC61968', 'public', 'cim_asset_info.model_number',
   'Model number from GIS manufacturer_model_number', 'GIS'),
  ('AssetInfo', 'PowerTransformerInfo', 'IEC61968', 'public', 'cim_asset_info.serial_number',
   'Serial number from GIS', 'GIS')
ON CONFLICT (local_schema, local_field, canonical_object) DO NOTHING;

GRANT SELECT ON public.cim_assets, public.cim_asset_info, public.power_transformers
  TO anon, authenticated, service_role;
