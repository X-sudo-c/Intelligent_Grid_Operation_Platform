-- FR-020: master topology DQ at scale — dangling lines + batch run registry.

INSERT INTO public.data_quality_rules (rule_code, domain, severity, description, blocks_promotion) VALUES
  (
    'TOPO_DANGLING_LINE_ENDPOINT',
    'topology',
    'critical',
    'Approved line segment references a missing source or target connectivity node.',
    TRUE
  ),
  (
    'TOPO_LINE_ENDPOINT_NOT_APPROVED',
    'topology',
    'major',
    'Line segment endpoint node is missing or not in APPROVED master validation state.',
    TRUE
  )
ON CONFLICT (rule_code) DO NOTHING;

-- Promote orphan rule severity for export visibility (still non-blocking for promotion of other assets).
UPDATE public.data_quality_rules
SET description = 'Approved master connectivity node has no incident line segment (orphan).'
WHERE rule_code = 'ASSET_ORPHAN_NODE';

CREATE TABLE IF NOT EXISTS public.data_quality_batch_runs (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scan_type        TEXT NOT NULL DEFAULT 'topology_master',
  status           TEXT NOT NULL DEFAULT 'running',
  orphans_found    BIGINT NOT NULL DEFAULT 0,
  orphans_inserted BIGINT NOT NULL DEFAULT 0,
  dangling_found   BIGINT NOT NULL DEFAULT 0,
  dangling_inserted BIGINT NOT NULL DEFAULT 0,
  auto_cleared     BIGINT NOT NULL DEFAULT 0,
  clip_west        DOUBLE PRECISION,
  clip_south       DOUBLE PRECISION,
  clip_east        DOUBLE PRECISION,
  clip_north       DOUBLE PRECISION,
  requested_by     TEXT,
  error_message    TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dq_batch_runs_started
  ON public.data_quality_batch_runs (started_at DESC);

COMMENT ON TABLE public.data_quality_batch_runs IS
  'Audit log for set-based DQ scans (topology orphans, dangling lines).';

GRANT SELECT, INSERT, UPDATE ON public.data_quality_batch_runs TO service_role;
GRANT SELECT ON public.data_quality_batch_runs TO authenticated;

-- Fast orphan lookup: nodes with no incident approved line.
CREATE INDEX IF NOT EXISTS idx_connectivity_nodes_orphan_scan
  ON public.connectivity_nodes (mrid)
  WHERE mrid IS NOT NULL;
