-- Faster steward import queue list/count for unpromoted rows (~800k+ rows).

CREATE INDEX IF NOT EXISTS idx_gis_conductor_import_status_unpromoted_list
  ON gis.conductor_import_status (district, source_layer, source_fid)
  WHERE reason <> 'already_promoted';
