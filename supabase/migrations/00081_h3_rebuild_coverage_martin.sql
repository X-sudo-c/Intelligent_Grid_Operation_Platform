-- Pre-aggregated H3 rebuild coverage hexes for Martin vector tiles (replaces per-pan GeoJSON).

CREATE TABLE IF NOT EXISTS public.h3_rebuild_coverage (
  h3_index         text NOT NULL,
  resolution       smallint NOT NULL CHECK (resolution BETWEEN 0 AND 15),
  verified_count   integer NOT NULL DEFAULT 0,
  staged_count     integer NOT NULL DEFAULT 0,
  reference_count  integer NOT NULL DEFAULT 0,
  geom             geometry(Polygon, 4326) NOT NULL,
  refreshed_at     timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (h3_index, resolution)
);

CREATE INDEX IF NOT EXISTS idx_h3_rebuild_coverage_geom
  ON public.h3_rebuild_coverage USING GIST (geom);

CREATE INDEX IF NOT EXISTS idx_h3_rebuild_coverage_resolution
  ON public.h3_rebuild_coverage (resolution);

COMMENT ON TABLE public.h3_rebuild_coverage IS
  'H3 hex aggregates for rebuild coverage map (Martin). Refreshed via sync-service POST /h3/coverage/refresh.';

GRANT SELECT ON public.h3_rebuild_coverage TO anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON public.h3_rebuild_coverage TO service_role;
