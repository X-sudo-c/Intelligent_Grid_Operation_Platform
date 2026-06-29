-- H3 spatial-index support: per-hex field-work assignments (rebuild territories).
-- Node H3 indexes themselves are computed on the fly by sync-service (h3 bindings),
-- so the grid works on existing and field-rebuilt data without a Postgres extension.

CREATE TABLE IF NOT EXISTS public.h3_cell_assignments (
  h3_index    text PRIMARY KEY,
  resolution  integer NOT NULL,
  assigned_to text,
  status      text NOT NULL DEFAULT 'ASSIGNED',
  note        text,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT h3_cell_assignments_status_chk
    CHECK (status IN ('ASSIGNED', 'IN_PROGRESS', 'DONE', 'BLOCKED'))
);

CREATE INDEX IF NOT EXISTS idx_h3_cell_assignments_assigned_to
  ON public.h3_cell_assignments (assigned_to);
CREATE INDEX IF NOT EXISTS idx_h3_cell_assignments_status
  ON public.h3_cell_assignments (status);
CREATE INDEX IF NOT EXISTS idx_h3_cell_assignments_resolution
  ON public.h3_cell_assignments (resolution);

COMMENT ON TABLE public.h3_cell_assignments IS
  'Field-rebuild work assignment per H3 hexagon (territory management + progress).';

GRANT SELECT ON public.h3_cell_assignments TO anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.h3_cell_assignments TO authenticated, service_role;

-- Live updates so portal + field app see assignment changes immediately.
ALTER PUBLICATION supabase_realtime ADD TABLE public.h3_cell_assignments;
