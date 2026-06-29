-- Recreate ECG regions overview when district boundaries exist (idempotent).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'gis' AND table_name = 'ecg_admin_boundaries'
  ) THEN
    PERFORM gis.ensure_boundary_overview_view(
      'gis', 'ecg_admin_boundaries', 'ecg_admin_regions', 'region'
    );
  END IF;
END $$;
