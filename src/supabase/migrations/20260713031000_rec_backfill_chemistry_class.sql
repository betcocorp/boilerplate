-- REC-2 / REC-3 — Heuristic backfill of chemistry_class + product_application from body_text.
--
-- STATUS: APPLIED 2026-07-13 to project gbkobtatfsjibkxebvdw (via management API) after the
-- column migration (20260713030000). Idempotent-ish: re-running re-derives from body_text.
--
-- ⚠️ HEURISTIC — needs human curation before it drives a HARD retrieval filter. It is priority-
-- ordered keyword matching over the product-line profile body; a quat product whose body also
-- mentions "peroxide"/"bleach" (e.g. a "safer than bleach" claim) can be mislabeled, which would
-- wrongly EXCLUDE the correct product from a chemistry-filtered query. Coverage after this pass:
-- 23 quat / 24 hypochlorite / 11 alcohol / 9 acid / 4 peroxide / 1 phenolic (of 1703 profiles);
-- 117 tagged disinfectant. Curate the ~72 chemistry-labeled disinfectant rows before enabling
-- the match-function filter (see 20260713030000 FOLLOW-UP block).

update rag.document set
  chemistry_class = case
    when body_text ~* '(sodium )?hypochlorite|\mbleach\M' then 'hypochlorite'
    when body_text ~* 'hydrogen peroxide|\mperoxide\M' then 'peroxide'
    when body_text ~* 'quaternary ammonium|\mquaternary\M|\mquat\M|didecyl dimethyl|alkyl dimethyl benzyl ammonium|\madbac\M' then 'quat'
    when body_text ~* '\mphenolic\M|phenylphenol' then 'phenolic'
    when body_text ~* 'isopropyl alcohol|isopropanol|\methanol\M|\methyl alcohol\M' then 'alcohol'
    when body_text ~* 'phosphoric acid|citric acid|hydrochloric acid|sulfamic acid|\mlactic acid\M' then 'acid'
    else null
  end,
  product_application = case
    when body_text ~* 'disinfect|sanitiz|bactericid|virucid|fungicid|kill claim' then 'disinfectant'
    when body_text ~* 'degreas' then 'degreaser'
    when body_text ~* 'floor finish|floor stripper|burnish|recoat|strip.{0,12}wax' then 'floor-care'
    when body_text ~* 'glass cleaner|window cleaner' then 'glass'
    when body_text ~* 'all.?purpose|neutral cleaner' then 'general-cleaner'
    else null
  end
where document_kind = 'product_line_profile';
