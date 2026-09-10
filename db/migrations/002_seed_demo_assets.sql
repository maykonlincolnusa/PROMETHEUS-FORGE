INSERT INTO assets (id, name, asset_type, state_code, health, vibration, temperature, operating_hours, criticality, status) VALUES
  ('VX-204', 'Field Vector 204', 'Ground vehicle', 'CA', 72, 78, 66, 1842, 92, 'attention'),
  ('GX-019', 'Auxiliary Generator 019', 'Power', 'TX', 89, 34, 42, 621, 74, 'normal'),
  ('AR-081', 'Aerial Unit 081', 'Aerial platform', 'VA', 58, 86, 79, 2307, 96, 'critical'),
  ('RC-112', 'Communications Relay 112', 'Communications', 'WA', 94, 12, 38, 424, 88, 'normal'),
  ('VX-178', 'Field Vector 178', 'Ground vehicle', 'FL', 81, 49, 55, 1220, 81, 'attention'),
  ('GX-028', 'Auxiliary Generator 028', 'Power', 'TX', 67, 71, 69, 1961, 69, 'attention')
ON CONFLICT (id) DO NOTHING;
