-- Asset condition is derived, not stored.
--
-- The status column held a hand-written label that could disagree with the
-- risk score computed from health, vibration, temperature and criticality.
-- Since lib/operations.js now derives the band from those inputs on every
-- read, a second stored copy can only be a source of contradiction.

DROP INDEX IF EXISTS assets_status_idx;
ALTER TABLE assets DROP COLUMN IF EXISTS status;
DROP TYPE IF EXISTS asset_status;

-- Align the demonstration inventory with data/assets.json so the PostgreSQL
-- and local-demo backends present the same fleet, and so the seed exercises
-- all three risk bands instead of only two.
UPDATE assets SET name = 'Vetor de Campo 204', asset_type = 'Veículo terrestre' WHERE id = 'VX-204';
UPDATE assets SET name = 'Gerador Auxiliar 019', asset_type = 'Energia' WHERE id = 'GX-019';
UPDATE assets SET name = 'Unidade Aérea 081', asset_type = 'Plataforma aérea', health = 44 WHERE id = 'AR-081';
UPDATE assets SET name = 'Relay de Comunicações 112', asset_type = 'Comunicações' WHERE id = 'RC-112';
UPDATE assets SET name = 'Vetor de Campo 178', asset_type = 'Veículo terrestre' WHERE id = 'VX-178';
UPDATE assets SET name = 'Gerador Auxiliar 028', asset_type = 'Energia' WHERE id = 'GX-028';
