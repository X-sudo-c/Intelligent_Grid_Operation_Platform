-- Legacy ECG conductor/transformer catalog rows are opt-in (full GPKG import).
-- Boundary-only deployments should not show empty network layers or probe missing Martin tables.

UPDATE gis.reference_layers
SET active = FALSE,
    updated_at = NOW()
WHERE kind = 'network';
