-- Offline mobile SQLite + SpatiaLite baseline (Module 8)
-- Apply on-device via sqflite; SpatiaLite optional for advanced geom queries.

CREATE TABLE IF NOT EXISTS field_captured_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mrid TEXT,
  name TEXT NOT NULL,
  longitude REAL NOT NULL,
  latitude REAL NOT NULL,
  asset_kind TEXT NOT NULL DEFAULT 'pole_lv',
  validation TEXT DEFAULT 'PENDING_FIELD',
  is_dirty INTEGER NOT NULL DEFAULT 1,
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS local_customer_profiles (
  account_mrid TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  balance_ghs REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS local_spot_bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_mrid TEXT NOT NULL,
  meter_mrid TEXT,
  previous_reading REAL NOT NULL,
  current_reading REAL NOT NULL,
  photo_path TEXT,
  is_dirty INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS offline_tiles_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  z INTEGER NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  layer_id TEXT NOT NULL,
  pbf_blob BLOB,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (z, x, y, layer_id)
);

CREATE INDEX IF NOT EXISTS idx_field_captured_dirty ON field_captured_assets (is_dirty);

-- ECG residential tiered tariff (offline estimate example):
-- SELECT
--   CASE
--     WHEN consumption <= 30 THEN consumption * 0.98
--     WHEN consumption <= 300 THEN 30 * 0.98 + (consumption - 30) * 1.25
--     ELSE 30 * 0.98 + 270 * 1.25 + (consumption - 300) * 1.75
--   END AS estimated_ghs
-- FROM (SELECT (current_reading - previous_reading) AS consumption FROM local_spot_bills WHERE id = ?);
