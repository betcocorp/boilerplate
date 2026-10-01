-- B0-930 (epic B0-929) — move the golden dataset onto typed arrays and retire the
-- behaviour-expectation columns.
--
-- `expected_concepts` / `minimum_concepts` were free text that the grader re-split at grade time
-- with `splitConcepts` (~/lib/tests/report/case-concepts.ts). The data is already pipe-delimited on
-- 1,015 of 1,031 rows, so this migration performs that same split once, in SQL, and stores the
-- phrases as `text[]`.
--
-- Regulated-data rule: the split is STRUCTURAL ONLY. Phrases are re-emitted verbatim — never
-- rounded, unit-converted, re-cased or truncated. Dilution ratios, oz/gal, mL/L, ppm, contact
-- times, CAS and EPA registration numbers pass through byte-for-byte.
--
-- `expected_should_answer` (1,030 populated, 447 of them false) and `expected_result_type` (16
-- populated) are dropped: run-time pass/fail moves onto mandatory concept coverage in B0-932.
-- `expected_sources` held source CATEGORIES ("Product Label", "VCT Floor Care Knowledge Base"),
-- not ids, so it cannot be converted — it becomes `uuid[]` of `rag.document.id`, empty everywhere.
--
-- Every value that cannot survive the retyping is archived under `metadata` first, so the old
-- ground truth stays recoverable from the row itself.

-- ---------------------------------------------------------------------------
-- Line-for-line SQL port of `splitConcepts`. Temporary: dropped at the end.
-- ---------------------------------------------------------------------------
create function public._b0930_split_concepts(cell text)
returns text[]
language plpgsql
immutable
as $fn$
declare
  txt      text;
  parts    text[] := '{}';
  line     text;
  seg      text;
  phrase   text;
  result   text[] := '{}';
begin
  if cell is null then
    return '{}';
  end if;

  -- Normalise line endings, then trim the whole cell (matches the TS `.trim()`).
  txt := btrim(replace(replace(cell, e'\r\n', e'\n'), e'\r', e'\n'));

  -- An empty cell, or one holding only an empty-cell marker, means "no concepts of this kind".
  if txt = '' or lower(txt) in ('n/a', 'na', 'none', '-', '—') then
    return '{}';
  end if;

  -- Pipe is the primary delimiter, per line; newlines split.
  foreach line in array string_to_array(txt, e'\n') loop
    if position('|' in line) > 0 then
      parts := parts || string_to_array(line, '|');
    else
      parts := parts || array[line];
    end if;
  end loop;

  -- Semicolons split only when nothing else delimited the cell.
  if coalesce(array_length(parts, 1), 0) = 1 and position(';' in txt) > 0 then
    parts := string_to_array(txt, ';');
  end if;

  foreach seg in array parts loop
    -- Strip a leading list marker: -, *, •, ‣, ▪, ·, a lone o, 1. / 1) / (1), or a. / a).
    phrase := regexp_replace(seg, '^\s*([-*•‣▪·oO]|\(?[0-9]+[.)]|[a-zA-Z][.)])\s+', '');
    phrase := btrim(phrase);
    phrase := btrim(regexp_replace(regexp_replace(phrase, '^;+', ''), ';+$', ''));
    if phrase <> '' then
      result := result || array[phrase];
    end if;
  end loop;

  return result;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 1. Archive everything the retyping cannot carry forward.
-- ---------------------------------------------------------------------------
update public.test_items
set metadata =
  metadata
  || case
       when nullif(btrim(coalesce(expected_sources, '')), '') is not null
         then jsonb_build_object('legacy_expected_sources', expected_sources)
       else '{}'::jsonb
     end
  || case
       when expected_should_answer is not null
         then jsonb_build_object('legacy_expected_should_answer', expected_should_answer)
       else '{}'::jsonb
     end
  || case
       when nullif(btrim(coalesce(expected_result_type, '')), '') is not null
         then jsonb_build_object('legacy_expected_result_type', expected_result_type)
       else '{}'::jsonb
     end
where expected_sources is not null
   or expected_should_answer is not null
   or expected_result_type is not null;

-- ---------------------------------------------------------------------------
-- 2. Concept columns: text -> text[], split with the ported splitter.
-- ---------------------------------------------------------------------------
alter table public.test_items
  alter column expected_concepts type text[] using public._b0930_split_concepts(expected_concepts),
  alter column minimum_concepts  type text[] using public._b0930_split_concepts(minimum_concepts);

update public.test_items set expected_concepts = '{}' where expected_concepts is null;
update public.test_items set minimum_concepts  = '{}' where minimum_concepts  is null;

alter table public.test_items
  alter column expected_concepts set default '{}',
  alter column expected_concepts set not null,
  alter column minimum_concepts  set default '{}',
  alter column minimum_concepts  set not null;

-- ---------------------------------------------------------------------------
-- 3. expected_criteria: jsonb (tiered objects) -> text[]. Zero rows populated live, so the
--    tier/exact structure is dropped rather than converted; tiers now come from which column a
--    concept lives in (B0-932).
-- ---------------------------------------------------------------------------
alter table public.test_items drop column expected_criteria;
alter table public.test_items add  column expected_criteria text[] not null default '{}';

-- ---------------------------------------------------------------------------
-- 4. expected_sources: prose categories -> uuid[] of rag.document.id. Not convertible; the old
--    text is in metadata.legacy_expected_sources from step 1.
-- ---------------------------------------------------------------------------
alter table public.test_items drop column expected_sources;
alter table public.test_items add  column expected_sources uuid[] not null default '{}';

-- ---------------------------------------------------------------------------
-- 5. Retire the behaviour-expectation columns.
-- ---------------------------------------------------------------------------
-- Deliberately two statements rather than one multi-clause ALTER: scripts/check-schema-drift.mjs
-- only reads the first `drop column` clause of an ALTER, and reported the second column as an
-- unapplied migration when they were combined.
alter table public.test_items drop column expected_should_answer;
alter table public.test_items drop column expected_result_type;

-- ---------------------------------------------------------------------------
-- 6. Document the new contract, then drop the helper.
-- ---------------------------------------------------------------------------
comment on column public.test_items.expected_concepts is
  'B0-930 — one concept phrase per element; the full success set (tier 2 at grade time). Regulated free text: stored and compared verbatim, never reformatted.';
comment on column public.test_items.minimum_concepts is
  'B0-930 — the mandatory subset (tier 1). Missing any element fails the item, mirroring the reference agent-evaluation skill''s minimal_gate.';
comment on column public.test_items.expected_criteria is
  'B0-930 — additional concept phrases graded alongside expected_concepts (tier 2). Replaced the B0-615 tiered jsonb, which had no populated rows.';
comment on column public.test_items.expected_sources is
  'B0-930 — rag.document.id values the answer should be grounded in. Not a real FK (Postgres cannot reference an array element); the admin picker only offers live document ids.';

drop function public._b0930_split_concepts(text);
