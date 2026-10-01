-- B0-199 — 079 AF79 — 7 rows
insert into rag.product_efficacy
  (entity_id, product_key, organism, claim_type, dilution_oz_per_gal, contact_time_seconds, epa_registration, source_record_id, source_page, confidence)
values
  ('8efad4b1-b0c6-4f8d-83dc-603652a67918', NULL, 'Pseudomonas aeruginosa', 'bactericidal', NULL, 60, '6836 193 4170', 'd9226703-ba5a-4bdc-887a-8d212fd8a448', NULL, 0.9),
  ('8efad4b1-b0c6-4f8d-83dc-603652a67918', NULL, 'Staphylococcus aureus', 'bactericidal', NULL, 60, '6836 193 4170', 'd9226703-ba5a-4bdc-887a-8d212fd8a448', NULL, 0.9),
  ('8efad4b1-b0c6-4f8d-83dc-603652a67918', NULL, 'Salmonella choleraesuis', 'bactericidal', NULL, 60, '6836 193 4170', 'd9226703-ba5a-4bdc-887a-8d212fd8a448', NULL, 0.9),
  ('8efad4b1-b0c6-4f8d-83dc-603652a67918', NULL, 'Herpes simplex Virus Type 2', 'virucidal', NULL, 600, '6836 193 4170', 'd9226703-ba5a-4bdc-887a-8d212fd8a448', NULL, 0.9),
  ('8efad4b1-b0c6-4f8d-83dc-603652a67918', NULL, 'HIV 1 (AIDS Virus)', 'virucidal', NULL, 30, '6836 193 4170', 'd9226703-ba5a-4bdc-887a-8d212fd8a448', NULL, 0.9),
  ('8efad4b1-b0c6-4f8d-83dc-603652a67918', NULL, 'Influenza Type A / Hong Kong', 'virucidal', NULL, 60, '6836 193 4170', 'd9226703-ba5a-4bdc-887a-8d212fd8a448', NULL, 0.9),
  ('8efad4b1-b0c6-4f8d-83dc-603652a67918', NULL, 'Tricophyton interdigitale (Athlete''s Foot Fungus/A Cause of Ringworm)', 'fungicidal', NULL, 600, '6836 193 4170', 'd9226703-ba5a-4bdc-887a-8d212fd8a448', NULL, 0.9);
