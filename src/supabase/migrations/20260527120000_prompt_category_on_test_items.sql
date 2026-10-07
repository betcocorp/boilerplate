-- ============================================================
-- 20260527120000_prompt_category_on_test_items.sql
--
-- Adds prompt_category to test_items with keyword-based
-- auto-classification:
--
--   1. classify_prompt_category(text) — IMMUTABLE classifier
--      matching against the 43-category taxonomy in
--      src/lib/constants/prompt-categories.ts
--   2. BEFORE INSERT OR UPDATE trigger — auto-classifies new
--      rows and prompt edits when category is null
--   3. Backfill of all existing test_items rows
--   4. Updated latest_failed_test_result_items view
--   5. Refreshed admin_latest_failures_page RPC (required to
--      pick up the new view column in its return type)
-- ============================================================


-- ── 1. Column ─────────────────────────────────────────────────────────────

ALTER TABLE public.test_items
  ADD COLUMN IF NOT EXISTS prompt_category text;


-- ── 2. Classifier function ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.classify_prompt_category(p_prompt text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  t text := lower(coalesce(p_prompt, ''));
BEGIN
  -- Out-of-scope (non-Betco topics)
  IF t ~* '\y(cooking|recipe|automotive|sports|finance|investing|electronics|travel|weather|medical advice|legal advice)\y' THEN
    RETURN 'out-of-scope';
  END IF;

  -- Competitor cross-reference
  IF t ~* '\y(spartan|ecolab|zep|diversey|sealed air|ncco|prestige brands|sc johnson|kimberly.?clark|lysol|clorox)\y'
     OR t ~* '\y(cross.?reference|equivalent to|alternative to)\y'
     OR t ~* '(replac(e|ing|ement)).{0,40}(betco|product)'
     OR t ~* '(betco|product).{0,40}(replac(e|ing))'
  THEN
    RETURN 'competitor';
  END IF;

  -- Pathogen-specific
  IF t ~* '\y(covid|coronavirus|sars.?cov|norovirus|mrsa|staphylococcus|salmonella|e\.?\s*coli|listeria|c\.?\s*diff|clostridium|influenza|hepatitis|tuberculosis|hiv|rsv|adenovirus|rotavirus|candida|legionella)\y' THEN
    RETURN 'pathogen-specific';
  END IF;

  -- First aid / exposure
  IF t ~* '\y(first.?aid|swallow(ed|ing)|ingest(ed|ion)|inhal(ed|ation)|skin contact|eye contact|poison(ing)?|accidental exposure|emergency treatment)\y' THEN
    RETURN 'first-aid';
  END IF;

  -- SDS / GHS hazard information
  IF t ~* '\y(sds\b|safety data sheet|ghs\b|hazard(ous)?|signal word|pictogram|nfpa|hmis)\y' THEN
    RETURN 'sds-hazard';
  END IF;

  -- PPE / safety handling
  IF t ~* '\y(ppe\b|gloves?|eye protection|goggles?|respirator|face shield|protective equipment|safety glasses|ventilat)\y' THEN
    RETURN 'safety-ppe';
  END IF;

  -- Kill claims / efficacy
  IF t ~* '\y(kill(s|ing|ed)?|efficac(y|ious)|effective against|eliminat(e|es|ing)|log reduction|bactericid(al|e)|virucid(al|e)|fungicid(al|e)|sporicide)\y' THEN
    RETURN 'kill-claims';
  END IF;

  -- Mixing / chemical compatibility
  IF t ~* '\y(can i mix|do not mix|never mix|incompatible|reacts? with|mixing.{0,20}(chemical|product)|(chemical|product).{0,20}mixing)\y' THEN
    RETURN 'mixing-compatibility';
  END IF;

  -- Disposal / environmental impact
  IF t ~* '\y(dispos(e|al|ing)|biodegradable|down the drain|landfill|voc\b|volatile organic|waste disposal|eco.?friendly)\y' THEN
    RETURN 'disposal-environmental';
  END IF;

  -- Storage / shelf life
  IF t ~* '\y(shelf.?life|expir(e|ation|es|ed)|how long.{0,20}(store|keep|last)|freezing|freeze|storage temperature)\y' THEN
    RETURN 'storage-shelf-life';
  END IF;

  -- EPA / certifications / green credentials
  IF t ~* '\y(epa.?reg(istration)?|registration number|dfe\b|design for the environment|safer choice|list n\b|green seal|ecologo|nsf.?ansi|prop 65|carb voc)\y' THEN
    RETURN 'epa-certifications';
  END IF;

  -- Dwell time / contact time
  IF t ~* '\y(dwell.?time|contact.?time|leave.{0,20}for.{0,20}minute|how long.{0,20}(wait|leave|sit|remain)|minutes? (of contact|before rins|before wip))\y' THEN
    RETURN 'dwell-time';
  END IF;

  -- Dilution ratios / concentrations
  IF t ~* '\y(dilut(e|ion|ed|ing|rate)|parts? per (gallon|quart)|ounces? per (gallon|quart)|concentrate|ready.?to.?use|rtu\b|use rate|mixing ratio)\y' THEN
    RETURN 'dilution';
  END IF;

  -- Dispensing systems / hardware
  IF t ~* '\y(dispenser|dispensing|proguard|proportioner|proportioning|metering tip|cartridge refill|wall.?mount(ed)? dispenser|dosing system)\y' THEN
    RETURN 'dispensing-systems';
  END IF;

  -- Surface compatibility
  IF t ~* '(safe (on|for|to use on)|(compatible|works?) (on|with).{0,30}(surface|floor|tile|wood|metal|fabric|stone|granite|marble|vinyl|carpet|concrete|grout))' THEN
    RETURN 'surface-compatibility';
  END IF;

  -- Floor care procedures
  IF t ~* '\y(strip(ping)?|floor finish|floor sealer|burnish(ing)?|vct\b|vinyl composition tile|resilient floor|recoat(ing)?|finish coat|floor wax|scrub and recoat)\y' THEN
    RETURN 'floor-care';
  END IF;

  -- Restroom / bathroom procedures
  IF t ~* '\y(restroom|bathroom|toilet|urinal|bowl cleaner|soap scum|hard water stain|tile and grout|shower stall)\y' THEN
    RETURN 'restroom-procedure';
  END IF;

  -- Odor control
  IF t ~* '\y(odor\b|deodor(ize|izer|ant|izing)?|malodor|fragrance|neutrali(ze|zer)|air freshener)\y' THEN
    RETURN 'odor-control';
  END IF;

  -- Product comparison
  IF t ~* '\y(compar(e|ing|ison)|difference between|versus|better than|which is better)\y'
     OR t ~ '\bvs\.?\b'
  THEN
    RETURN 'product-comparison';
  END IF;

  -- Packaging / sizes / formats
  IF t ~* '\y(gallon|quart|liter|litre|ounce|\boz\b|drum|pail|case (of|pack)|packaging|how (many|much).{0,20}(per case|in a case|come in))\y' THEN
    RETURN 'packaging';
  END IF;

  -- Facility type / vertical market
  IF t ~* '\y(hospital|healthcare|health care|school|university|food service|restaurant|hotel|office building|warehouse|\bgym\b|stadium|nursing home|long.?term care|assisted living|daycare|correctional)\y' THEN
    RETURN 'facility-type';
  END IF;

  -- Product type classification
  IF t ~* '\y(what (type|kind|category|class).{0,20}(product|chemical)|is (it|this|betco) a (cleaner|disinfectant|sanitizer|degreaser|descaler|floor finish|stripper|detergent))\y' THEN
    RETURN 'product-type';
  END IF;

  -- Catch-all
  RETURN 'recommendation';
END;
$$;


-- ── 3. Auto-classify trigger ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.test_items_auto_classify()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.prompt_category IS NULL THEN
    NEW.prompt_category := public.classify_prompt_category(NEW.prompt);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS test_items_classify_prompt ON public.test_items;

CREATE TRIGGER test_items_classify_prompt
  BEFORE INSERT OR UPDATE OF prompt ON public.test_items
  FOR EACH ROW EXECUTE FUNCTION public.test_items_auto_classify();


-- ── 4. Backfill all existing rows ─────────────────────────────────────────

UPDATE public.test_items
SET prompt_category = public.classify_prompt_category(prompt)
WHERE prompt_category IS NULL;


-- ── 5. Update view to expose prompt_category ─────────────────────────────
-- Preserves the original column order; inserts prompt_category after prompt.

CREATE OR REPLACE VIEW public.latest_failed_test_result_items AS
SELECT DISTINCT ON (tri.test_item_id)
  tri.id,
  tri.test_result_id,
  tri.test_item_id,
  tri.row_index,
  tri.passed,
  tri.status,
  tri.elapsed_ms,
  tri.error_message,
  tri.response_text,
  tri.response_payload,
  tri.created_at,
  ti.prompt,
  ti.prompt_category,
  ti.test_id,
  ti.row_index AS item_row_index,
  t.name         AS test_name,
  tr.created_at  AS run_created_at
FROM public.test_result_items tri
JOIN public.test_items   ti ON ti.id = tri.test_item_id
JOIN public.test_results tr ON tr.id = tri.test_result_id
JOIN public.tests         t ON  t.id = ti.test_id
WHERE tri.passed = false
ORDER BY tri.test_item_id, tri.created_at DESC;


-- ── 6. Refresh RPC (must be recreated to pick up new view column) ─────────

DROP FUNCTION IF EXISTS public.admin_latest_failures_page(text, integer, integer);

CREATE OR REPLACE FUNCTION public.admin_latest_failures_page(
  p_search text,
  p_limit  integer,
  p_offset integer
)
RETURNS SETOF public.latest_failed_test_result_items
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM public.latest_failed_test_result_items v
  WHERE trim(coalesce(p_search, '')) = ''
     OR position(lower(trim(p_search)) IN lower(v.prompt))         > 0
     OR position(lower(trim(p_search)) IN lower(coalesce(v.error_message,  ''))) > 0
     OR position(lower(trim(p_search)) IN lower(coalesce(v.response_text,  ''))) > 0
     OR position(lower(trim(p_search)) IN lower(v.test_name))      > 0
  ORDER BY v.created_at DESC
  LIMIT  CASE WHEN p_limit  < 1 THEN 25 WHEN p_limit  > 100 THEN 100 ELSE p_limit  END
  OFFSET greatest(p_offset, 0);
$$;
