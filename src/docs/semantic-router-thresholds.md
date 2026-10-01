# Semantic router thresholds — tuning guide (B0-650)

Scope: the two gates in `src/lib/orchestrator/semantic-router.ts`. This document exists because the
B0-650 acceptance criteria ask for a documented tuning strategy; it is not general project
documentation and should not grow beyond that.

## What the two thresholds are

The router embeds the user's message once and scores every SME route as the **maximum** cosine
similarity between that message vector and the route's example utterances in
`semantic-router-examples.ts`. Two independent gates then decide whether the winning route can be
trusted. **Both** must pass; failing either returns `path: 'fallback'` with `route: 'ambiguous'`.

| Setting | Default | Question it answers |
| --- | --- | --- |
| `SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD` | `0.50` | "Is this a real match at all?" — the top route's absolute similarity |
| `SEMANTIC_ROUTER_MARGIN_THRESHOLD` | `0.10` | "Is it a clear winner?" — top similarity minus the runner-up's |

They fail differently and must be tuned separately:

- **Confidence** is the *off-topic* guard. "What's the weather in Toledo?" is nobody's specialty; its
  best similarity against all 50 utterances is low, so no route should claim it.
- **Margin** is the *overlap* guard. "How do I disinfect the locker room floor?" is genuinely both
  `bathroom` and `floor`; both score high, and the difference between them is noise. Routing on a
  coin-flip is worse than falling back to the generalist, because the specialist prompt narrows the
  toolset around a guess.

A third knob, `SEMANTIC_ROUTER_EMBEDDING_MODEL`, is not a tuning dial — it is pinned to
`text-embedding-3-large` because the router enforces a 3072-dimension invariant. Changing it means
re-embedding the corpus (bump `SEMANTIC_ROUTER_EXAMPLES_VERSION`) and teaching the cache a second
dimension count first.

## Why 0.50 / 0.10 — and the honest caveat

These are **starting points, not measured optima.**

With max-over-examples cosine on `text-embedding-3-large`, two English sentences about the same
topic typically land somewhere in the **0.3–0.6** band; near-paraphrases of an actual corpus
utterance reach 0.7–0.9, and unrelated sentences still sit around 0.05–0.25 (these models do not
produce near-zero similarity for unrelated text). So:

- `0.50` sits at the **top** of the ordinary same-topic band. It is deliberately conservative: on a
  brand-new corpus, a false route is more expensive than a fallback, because the fallback path is
  the generalist behavior the product already ships. Expect it to prove **too strict** and to push
  the fallback rate higher than is useful. `0.40`–`0.45` is the likely landing zone.
- `0.10` is a small margin by design. Adjacent routes here (`bathroom`/`floor`, `product`/anything)
  overlap in vocabulary, so a large margin would fall back constantly. It is a tie-breaker, not a
  second confidence gate.

Do not treat either number as validated. Tune them against observed data (the B0-652 eval set and
real `path: 'fallback'` rates), not against intuition about what a similarity "should" be.

## Which way to move which knob

Every decision carries `scores`, `thresholds`, `thresholdsPassed`, and `margin`, so a symptom can
always be attributed to a specific gate before anything is changed.

| Symptom | Diagnosis | Action |
| --- | --- | --- |
| High fallback rate; `thresholdsPassed.confidence` false but the top route is the right one | Confidence too strict for this corpus | Lower `SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD` in 0.05 steps |
| High fallback rate; `thresholdsPassed.margin` false with two plausible routes tied | Genuine route overlap | Prefer **sharpening the examples** for the two routes; only then lower the margin |
| Off-topic/small-talk messages routed to a specialist | Confidence too permissive | Raise `SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD` |
| Confidently routed to the *wrong* specialist, high margin | The corpus is wrong, not the thresholds | Fix/add examples for the correct route; **bump `SEMANTIC_ROUTER_EXAMPLES_VERSION`** |
| One route wins almost everything | That route's examples are too generic | Narrow them; `product` is the usual culprit as the catch-all |
| Both gates barely pass on nearly every message | Corpus utterances are too similar across routes | Rewrite for discrimination — the routes are not separable yet |

Two rules that matter more than the numbers:

1. **Change one knob at a time**, then re-run the eval. The gates interact through the same score
   distribution; moving both leaves you unable to attribute the difference.
2. **A corpus fix beats a threshold fix.** Thresholds trade false routes against fallbacks along a
   fixed curve; better examples move the curve. If a route is wrong rather than merely unconfident,
   the examples are the bug.

## Where the numbers live

- Defaults and clamping: `src/lib/orchestrator/semantic-router-config.ts`
  (out-of-range stored values are clamped into `[0,1]`; a missing/unreadable row falls back to the
  default rather than failing the turn).
- Live values: the `settings` table, editable at `/admin/settings`, seeded by
  `src/supabase/migrations/20260825100000_add_semantic_router_settings_b0647_b0650.sql`. Reads are
  cached ~30s per key by `settings-service`, so a change takes up to half a minute to take effect —
  no deploy required.
- The comparison itself is `>=` on raw floats. Similarities are never exact decimals in practice, so
  a value sitting exactly on a threshold is a test-only concern, not a production one.
