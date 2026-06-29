-- Remove mistaken overview catalog row from wizard imports before ECG overview fix.
DELETE FROM gis.reference_layers
WHERE slug = 'ecg-admin-boundaries-overview';

-- Drop orphan overview table if created by mistake.
DROP TABLE IF EXISTS gis.ecg_admin_boundaries_overview;
