-- REC-3 / B0-76 — seed the curated Spartan BNC-15 -> Betco Triforce (#333) cross-reference.
-- APPLIED 2026-07-13 to project gbkobtatfsjibkxebvdw. Grounded: same manufacturer (EPA registrant
-- 6836); BNC-15 6836-348 and Triforce 6836-349 are the equivalent one-step quat disinfectant formula.
insert into public.cross_reference_override
  (competitor_brand, competitor_product, competitor_epa_reg, betco_product_key,
   betco_product_line_id, betco_title, chemistry_class, rationale, confidence, created_by)
select 'Spartan','BNC-15','6836-348','78E50F0B-4C4E-44D5-B014-96CD668D428D',
   '333','Triforce Disinfectant','quat',
   'Same third-party manufacturer (EPA registrant 6836): Spartan BNC-15 (6836-348) and Betco Triforce (6836-349) are the equivalent one-step quaternary-ammonium disinfectant formula — hospital broad-spectrum, one-step clean+disinfect.',
   0.98,'rec-seed-bnc15'
where not exists (
  select 1 from public.cross_reference_override
  where lower(competitor_brand)='spartan' and lower(competitor_product)='bnc-15'
);
