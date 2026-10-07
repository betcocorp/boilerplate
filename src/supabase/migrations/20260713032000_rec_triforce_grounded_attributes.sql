-- REC-2/REC-3 — Grounded attribute fix for the Triforce Disinfectant profile (prod line 333).
-- APPLIED 2026-07-13 to project gbkobtatfsjibkxebvdw (via management API).
-- Values sourced from Triforce's own SDS (document_kind='sds', product code 333), NOT fabricated:
--   composition lists quaternary ammonium compounds (didecyldimethylammonium chloride,
--   benzyl-C12-16-alkyldimethyl ammonium chlorides) -> chemistry_class 'quat';
--   "EPA Registration Number : 6836-349" -> epa_registration (epa_registrant generates to 6836,
--   the same registrant as Spartan BNC-15's 6836-348). The marketing profile body ("1 Minute
--   Disinfectant") lacked these terms, so the keyword backfill (20260713031000) left them null.
update rag.document
  set chemistry_class = 'quat', epa_registration = '6836-349'
  where id = '1467c468-e18f-4898-88ba-3a9d84c2274e';  -- title "1 Minute Disinfectant", prod_line_id 333
