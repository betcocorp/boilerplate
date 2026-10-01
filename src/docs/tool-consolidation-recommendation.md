# Function-tool consolidation recommendation (B0-383)

Design record for the B0-383 "track per-tool routing accuracy, plan tool consolidation" ticket.
Covers what was instrumented, what the live production data actually shows, and a concrete
consolidation recommendation for the 14 function tools in `~/lib/tools/definitions.ts`.

## What "at least one run's data" means here

The ticket asks for the recommendation to be "backed by at least one full eval run's data." The
`/admin/tests` harness has never had a test item tagged with the new `expected_tool` field before
this ticket (it didn't exist), so there is no harness eval run to point to yet — that data will
start accumulating once test authors add `expected_tool` to their CSVs (see
`~/lib/tests/template.ts`) and re-run their eval sets.

What already exists, and what this recommendation is grounded in instead, is **live production
`toolTrace` data**: every real Bex chat turn persists its tool call trace on the
`openai_responses_agent` `workflow_steps` row (`output.toolTrace`, B0-331/B0-390) — the exact same
shape the new harness instrumentation (`~/lib/tests/tool-routing.ts`) reads. Pulled 2026-08-15
(read-only, via the service-role client) over every `workflow_steps` row with
`step_name = 'openai_responses_agent'` and `status = 'completed'`:

| Metric | Value |
|---|---|
| Agent-step rows scanned | 9,434 |
| Rows with a persisted `toolTrace` | 1,344 (the rest predate the B0-331 capture rollout — no trace, not zero calls) |
| Total tool calls across those 1,344 steps | 1,593 |

**Caveat:** this is production traffic, not a graded eval run, so it shows *what the model called*,
never *whether it was the right tool for the question* — that half is exactly what this ticket's
`expected_tool` + routing-accuracy instrumentation adds going forward. Treat the recommendation
below as directional (strong signal on which tools are unused/overlapping) and re-validate it once
harness runs with `expected_tool` tags exist.

## Per-tool call frequency (live production, 1,344 traced runs)

| Tool | Calls | % of calls | Distinct runs | Origin breakdown (where tagged) |
|---|--:|--:|--:|---|
| `search_product_docs` | 1,316 | 82.6% | 1,254 | `workflow_injected` 656 (B0-436 speculative retrieval), `model_chosen` 18, untagged 642 |
| `get_efficacy_data` | 90 | 5.7% | 55 | `model_chosen` 1, untagged 89 |
| `lookup_cross_reference` | 79 | 5.0% | 70 | `safety_net_override` 24, `tool_choice_forced` 9, `model_chosen` 9, untagged 37 |
| `get_products_in_category` | 45 | 2.8% | 44 | untagged 45 |
| `find_products_by_category` | 18 | 1.1% | 18 | untagged 18 |
| `recommend_cross_reference` | 14 | 0.9% | 14 | `model_chosen` 2, untagged 12 |
| `list_allowed_surfaces` | 9 | 0.6% | 9 | untagged 9 |
| `get_product_category` | 8 | 0.5% | 8 | untagged 8 |
| `get_safety_constraints` | 8 | 0.5% | 8 | untagged 8 |
| `list_disallowed_uses` | 4 | 0.3% | 4 | untagged 4 |
| `get_product_spec` | 1 | 0.06% | 1 | untagged 1 |
| `get_approved_usage_guidance` | 1 | 0.06% | 1 | untagged 1 |
| `get_compatibility_rules` | 0 | 0% | 0 | — |
| `get_escalation_policy` | 0 | 0% | 0 | — |

"Untagged" = calls that predate the B0-390 `origin` field, not calls of unknown *type* — the origin
tagging landed after most of these 1,344 traces were written, so most rows simply don't carry it.

## Reading the numbers

- **`search_product_docs` is already the dominant, correct default** (82.6% of all calls). Its
  description already documents that each source is "a full approved document" — not a
  section-filtered excerpt — and it already accepts an optional `topic` string. That optional
  `topic` is the exact mechanism the six thin variants below exist to hard-code.
- **Six tools are the "thin RAG variants" the ticket calls out**, and together they account for 23
  calls out of 1,593 (1.4%) across the whole traced sample: `get_product_spec` (1),
  `get_approved_usage_guidance` (1), `get_safety_constraints` (8), `get_compatibility_rules` (0),
  `list_allowed_surfaces` (9), `list_disallowed_uses` (4). Each has an (almost) identical
  `productId`/`productName` schema and differs from `search_product_docs` only in which
  hard-coded `topic` it implicitly searches for. Two of them were never called at all in the traced
  sample.
- **`get_escalation_policy`** was never called either. Per its own description it returns "internal
  escalation guidance by issue type (policy text, not customer-specific data)" — static reference
  text, not a per-product RAG lookup, so routing it through a model tool call is pure overhead for
  content that doesn't need retrieval at all.
- **`get_efficacy_data` is structurally different, not overlapping** — it's a deterministic,
  typed-column EXACT lookup (dilution ratios, EPA registration, kill claims), not prose/semantic
  retrieval, and Betco's regulated-data rule (never round/convert/infer oz/gal, ppm, contact times,
  EPA reg numbers) makes it load-bearing that this stays its own tool rather than folding into
  fuzzy search.
- **`lookup_cross_reference` / `recommend_cross_reference` are sequential stages of one flow, not
  overlapping alternatives.** Only `lookup_cross_reference` has `tool_choice_forced` (9) and
  `safety_net_override` (24) entries — the workflow deterministically forces or safety-nets this
  specific lookup — and `recommend_cross_reference`'s own description says to call it "ONLY after
  `lookup_cross_reference` returns no match." Keep both.
- **The three category/taxonomy tools are a genuinely different question shape** (browsing/filtering
  "what floor strippers do you have" vs. asking about a named product) and together are real,
  non-trivial usage — 71 calls (4.5%) across 70 distinct runs. Worth keeping as a group, though
  `get_product_category` (8 calls) is a plausible smaller merge into `find_products_by_category`'s
  response shape (return the category alongside the matched products) since "what category is X in"
  and "what's in category Y" are two directions of the same taxonomy edge.

## Recommendation

**Merge into `search_product_docs`** (retire as standalone tools; route their use case through
`search_product_docs`'s existing `topic` parameter, e.g. `topic: "safety/PPE"`,
`topic: "compatibility"`, `topic: "allowed surfaces"`, `topic: "disallowed uses"`):
- `get_product_spec`
- `get_approved_usage_guidance`
- `get_safety_constraints`
- `get_compatibility_rules`
- `list_allowed_surfaces`
- `list_disallowed_uses`

**Retire entirely** (fold into a static specialist system-prompt block instead of a tool call —
it's policy text, not a retrieval or per-product lookup):
- `get_escalation_policy`

**Keep as-is** (each is disjoint from `search_product_docs` on a real axis — data source, exactness
guarantee, or forcing mechanics — not just a different prompt for the same corpus):
- `search_product_docs` (absorbs the six merged tools' use cases via `topic`)
- `get_efficacy_data` (deterministic exact lookup; regulated-data rule requires it stay separate)
- `lookup_cross_reference` / `recommend_cross_reference` (sequential stages of one flow, with
  distinct forced/safety-net call paths only `lookup_cross_reference` has)
- `get_products_in_category`, `find_products_by_category`, `get_product_category` (genuinely
  different — taxonomy navigation, not prose retrieval; `get_product_category` is a candidate for a
  smaller follow-up merge into `find_products_by_category`, not this pass)

**Net effect:** 14 tools → 7 (`search_product_docs`, `get_efficacy_data`, `lookup_cross_reference`,
`recommend_cross_reference`, `get_products_in_category`, `find_products_by_category`,
`get_product_category`), concentrating routing decisions onto the tools real traffic already prefers
and removing the six near-zero-usage, schema-duplicate adapters most likely to cause the misrouting
this ticket's instrumentation now measures directly.

## Before implementing the merge

1. Re-run this analysis once `/admin/tests` eval sets carry `expected_tool` tags and a full harness
   run has executed, so the consolidation is validated against graded routing-accuracy data, not
   just raw call-frequency.
2. Confirm none of the six merge-candidate tools are relied on by a caller other than the Bex
   product-support agent loop (`~/lib/tools/tool-registry.ts`'s `/api/v1/tools/*` registry is
   separate and unaffected — it only exposes `web-search` and `efficacy`).
3. Any tool-schema change must follow the repo's "Zod schemas first" rule
   (`~/lib/tools/tool-schemas.ts` → `~/lib/tools/definitions.ts` → `~/lib/tools/execute-tool-call.ts`
   → route-scoped tool sets in `productSupportToolsForRoute`), and should update
   `PRODUCT_TOOL_NAMES` and any per-route inclusion lists in the same change.
