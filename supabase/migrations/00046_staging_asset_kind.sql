-- Field-selected asset type on staging captures (before GIS linkage on promote).

ALTER TABLE staging.ghana_grid_assets
  ADD COLUMN IF NOT EXISTS asset_kind TEXT NOT NULL DEFAULT 'connectivity_node';

COMMENT ON COLUMN staging.ghana_grid_assets.asset_kind IS
  'Field-selected asset type (pole_lv, pole_11kv, distribution_transformer, etc.).';
