-- B0-495 — promote per-item similarity/confidence numerics out of
-- `test_result_items.response_payload` into stored generated columns, the same pattern B0-394
-- already used for `prompt_version`/`answer_provenance`, so distribution analysis (percentiles,
-- per-provenance-class averages) can use an index instead of an app-side JSON scan.
--
-- Sequencing note (why this lands after B0-490 and B0-492, not before): `max_similarity` is
-- generated from `response_payload -> 'similaritySummary' ->> 'selectedTopSimilarity'` — the
-- B0-490 field — NOT from a max() over `sources[].similarity`. Indexing the old ad-hoc number
-- would have been indexing the exact defect B0-490 fixed. `confidence_provenance` and
-- `agent_confidence` are generated from the B0-492/B0-491 fields for the same reason: index the
-- corrected/newly-captured values, not a placeholder.
--
-- Numeric safety: unlike B0-394's plain-text columns, these are numeric casts, which DO throw on
-- a non-numeric input — so every cast here is guarded by `jsonb_typeof(...) = 'number'` first.
-- This also makes the "rows written before each field existed" case safe for free: `->` on a
-- missing key or a NULL response_payload yields SQL NULL, `jsonb_typeof(NULL)` is NULL (not
-- `'number'`), so the CASE falls through to NULL rather than attempting (and failing) a cast.
-- `confidence_provenance` is plain text (mirrors B0-394's `nullif(..., '')` idiom; not
-- CHECK-constrained here for the same "don't fail a write on an enum the app schema will grow"
-- reason B0-394 gave for `answer_provenance`).
alter table public.test_result_items
  add column if not exists max_similarity double precision
    generated always as (
      case
        when jsonb_typeof(response_payload -> 'similaritySummary' -> 'selectedTopSimilarity') = 'number'
          then (response_payload -> 'similaritySummary' ->> 'selectedTopSimilarity')::double precision
        else null
      end
    ) stored,
  add column if not exists confidence double precision
    generated always as (
      case
        when jsonb_typeof(response_payload -> 'confidence') = 'number'
          then (response_payload ->> 'confidence')::double precision
        else null
      end
    ) stored,
  add column if not exists confidence_provenance text
    generated always as (nullif(response_payload ->> 'confidenceProvenance', '')) stored,
  add column if not exists agent_confidence double precision
    generated always as (
      case
        when jsonb_typeof(response_payload -> 'agentConfidence') = 'number'
          then (response_payload ->> 'agentConfidence')::double precision
        else null
      end
    ) stored;

comment on column public.test_result_items.max_similarity is
  'B0-495. Generated from response_payload->similaritySummary->>''selectedTopSimilarity'' (the B0-490-corrected post-selection top retrieval similarity — NOT a max() over sources[].similarity). Null for items predating B0-490, or any turn where no search tool ran.';

comment on column public.test_result_items.confidence is
  'B0-495. Generated from response_payload->>''confidence'' (numeric-safe: only cast when the JSON value is actually a number). Null for items predating confidence capture or with a malformed payload value. Pair with confidence_provenance before aggregating — see B0-492.';

comment on column public.test_result_items.confidence_provenance is
  'B0-495. Generated from response_payload->>''confidenceProvenance'' (B0-492): validator_judged, validator_bypassed_heuristic, decline_gate_constant, agent_self_scored, or gate_capped. Null for items predating B0-492 — treat as unknown, never as validator_judged. Free text by design; the enum is enforced by confidenceProvenanceSchema in the app.';

comment on column public.test_result_items.agent_confidence is
  'B0-495. Generated from response_payload->>''agentConfidence'' (B0-491) — the answering agent''s own self-reported confidence, distinct from the confidence column above. Null for items predating B0-491, or where the model returned no parseable self-score this turn.';

-- Partial indexes: every row recorded before this epic (and any row whose source field never
-- populated, e.g. no search ran) has NULL here, and that skew is permanent for historical data.
-- `where ... is not null` keeps each index proportional to instrumented rows only, matching the
-- B0-394 precedent.
create index if not exists test_result_items_max_similarity_idx
  on public.test_result_items (max_similarity)
  where max_similarity is not null;

create index if not exists test_result_items_confidence_idx
  on public.test_result_items (confidence)
  where confidence is not null;

create index if not exists test_result_items_confidence_provenance_idx
  on public.test_result_items (confidence_provenance)
  where confidence_provenance is not null;

create index if not exists test_result_items_agent_confidence_idx
  on public.test_result_items (agent_confidence)
  where agent_confidence is not null;

-- B0-492's per-provenance-class aggregate (e.g. "average confidence, judgment-only") filters on
-- confidence_provenance and reduces confidence — lead with the equality column so the planner can
-- use this index for both the filter and the aggregate without a second lookup.
create index if not exists test_result_items_confidence_provenance_confidence_idx
  on public.test_result_items (confidence_provenance, confidence)
  where confidence_provenance is not null;
