-- Speed Martin tile queries for map_unpromoted_conductor_segments (766k+ rows).

CREATE INDEX IF NOT EXISTS idx_gis_conductor_segments_geom_gist
  ON gis.conductor_segments USING GIST (geom)
  WHERE geom IS NOT NULL;
