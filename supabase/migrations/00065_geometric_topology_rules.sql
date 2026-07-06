-- ArcGIS-style geometric topology: endpoint snap tolerance + true geometric dangles.

INSERT INTO public.data_quality_rules (rule_code, domain, severity, description, blocks_promotion) VALUES
  (
    'TOPO_LINE_ENDPOINT_GEOM_MISMATCH',
    'topology',
    'major',
    'Line geometry start/end must coincide with source/target node locations (within tolerance).',
    FALSE
  ),
  (
    'TOPO_GEOM_DANGLING_ENDPOINT',
    'topology',
    'major',
    'Line geometry endpoint is not within tolerance of any connectivity node (geometric dangle).',
    FALSE
  ),
  (
    'TOPO_LINE_CROSSING_WITHOUT_NODE',
    'topology',
    'minor',
    'Two line segments cross without a connectivity node at the intersection.',
    FALSE
  )
ON CONFLICT (rule_code) DO NOTHING;
