-- Phase 1 correctness fixes (codebase review):
-- 1. staging.ac_line_segments was created in 00047 without PostgREST grants,
--    so REST/realtime clients could not read field-captured spans.
-- 2. Missing indexes on hot filter/join columns flagged in review:
--    identified_objects.validation (both tiers), gis.asset_id_map(mrid),
--    staging line endpoint FKs (promotion + span lookups join on them).

-- 1. Grants (match the other staging tables from 00009).
GRANT SELECT ON staging.ac_line_segments TO anon, authenticated;

-- 2. Indexes.
CREATE INDEX IF NOT EXISTS idx_identified_objects_validation
  ON public.identified_objects (validation);

CREATE INDEX IF NOT EXISTS idx_staging_identified_objects_validation
  ON staging.identified_objects (validation);

CREATE INDEX IF NOT EXISTS idx_gis_asset_id_map_mrid
  ON gis.asset_id_map (mrid);

CREATE INDEX IF NOT EXISTS idx_staging_ac_line_segments_source
  ON staging.ac_line_segments (source_node_id);

CREATE INDEX IF NOT EXISTS idx_staging_ac_line_segments_target
  ON staging.ac_line_segments (target_node_id);
