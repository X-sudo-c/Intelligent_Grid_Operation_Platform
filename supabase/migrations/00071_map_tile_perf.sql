-- Refresh planner stats after full line restore (Martin tiles + graph chunk bbox queries).

ANALYZE public.ac_line_segments;
ANALYZE public.connectivity_nodes;
ANALYZE public.conducting_equipment;
