# Semantic router — rollout, monitoring and rollback (B0-649 / B0-651 / B0-653)

Operator runbook for turning the embedding-similarity semantic router
(`~/lib/orchestrator/semantic-router.ts`) into the router that decides Bex orchestrator turns, and
for backing that out again.

> The B0-653 AC names `src/docs/orchestrator-implementation-plan.md`. **That file does not exist in
> this repo** (checked 2026-08-25) and is not created by this work — the cutover, monitoring and
> rollback content the AC asks for lives here instead.

---

## 1. What decides a turn's route

`runProductSupportWorkflow` (`~/lib/workflows/product-support/run-product-support-workflow.ts`)
resolves `routingDecision` through one precedence chain. The value space is unchanged
(`SmeAgentId | 'ambiguous'`), because the prompt selection, prompt-cache key, route-scoped tool
schemas, prompt version and cross-reference gating are all keyed on it.

| # | Flags | Who decides | LLM classifier called? |
|---|-------|-------------|------------------------|
| 1 | `BEX_SEMANTIC_ROUTER_ENABLED=true`, `BEX_SEMANTIC_ROUTER_SHADOW_MODE=false`, semantic `path='semantic'` | semantic router | **No** |
| 2 | same as above, but semantic `path='fallback'` | LLM classifier → keyword agent → `'ambiguous'` | Yes (only on this path) |
| 3 | `ENABLED=true`, `SHADOW_MODE=true` | LLM classifier / keyword router (semantic runs for logging only) | Yes |
| 4 | `ENABLED=false` | LLM classifier / keyword router — byte-identical to pre-B0-649 | Yes |

A forced direct `agentMode` (an admin picking a specialist in the Bex UI) bypasses routing entirely
and never calls any router.

Row 2 is the deliberate design choice: a degraded semantic router falls back to **today's safety
net**, not to `'ambiguous'`. The existing `BEX_LLM_ROUTER_ENABLED` / `BEX_LLM_ROUTER_SHADOW_MODE`
levers keep working untouched underneath it.

### Settings rows

Owned by this work (seeded by `20260825110000_add_semantic_router_flags_b0649.sql`, both `false`):

| Key | Type | Default |
|-----|------|---------|
| `BEX_SEMANTIC_ROUTER_ENABLED` | boolean | `false` |
| `BEX_SEMANTIC_ROUTER_SHADOW_MODE` | boolean | `false` |

Owned by the router itself (B0-647/B0-648), listed here only because the runbook reads them:
`SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD` (`0.50`), `SEMANTIC_ROUTER_MARGIN_THRESHOLD` (`0.10`),
`SEMANTIC_ROUTER_EMBEDDING_MODEL` (`text-embedding-3-large`).

All are read via `getBooleanSetting`, which caches for 30s — allow **up to 30 seconds** for a flag
flip to take effect on a warm server, and note that in-flight turns keep the flag state they
started with (every flag is read once per turn, on purpose).

### Not built: percentage cohorting

The epic's `SEMANTIC_ROUTER_ROLLOUT_PERCENTAGE` was a "consider", not an AC, and is **deliberately
not implemented**. Shadow mode already yields a full-traffic comparison at zero routing risk, and a
percentage cohort would make every aggregate below a mixture of two routers with no cohort column
to split on. Rollout is staged by flag, not by cohort.

---

## 2. Where the data lives

There is **no Prometheus, StatsD or OpenTelemetry exporter in bex-2.0**. The B0-651 AC's "confirm in
Prometheus" does not apply. Observability here is two things:

1. **Structured logs** — one `semantic_router_decision` line per decision, via
   `logInfo`/`logWarn` (`~/lib/observability/logger.ts`). Fallbacks are logged at **warn** level so
   the abort signal is greppable without a payload filter. Fields: `route`, `path`, `confidence`,
   `similarity`, `margin`, `scores` (every route's similarity, as a flat object),
   `confidenceThreshold`, `marginThreshold`, `confidenceThresholdPassed`, `marginThresholdPassed`,
   `latencyMs`, `embeddingMs`, `scoringMs`, `embeddingModel`, `examplesVersion`, `error`,
   `routingDecision`, `decidedBy`, `mode`, `traceId`, `conversationId`.
2. **Persisted Supabase rows** — the same field set as a `GateRecord` on the
   `orchestration_planner` step (`workflow_steps.output -> 'gates'`), under gate id
   `semantic_router_live` or `semantic_router_shadow`. Plus four fields on
   `workflow_runs.final_output.runtimeConfig`: `semanticRouterEnabled`,
   `semanticRouterShadowMode`, `semanticRouterPath`, `semanticRouterDecided`.

The five metrics the ticket names are implemented as **query-time reducers over those persisted
rows**, in `~/lib/observability/routing-health.ts`, named after the metrics so the mapping is
one-to-one:

| Ticket metric | Reducer output |
|---|---|
| `semantic_router_route` (counter per route, labeled by path) | `semanticRouter.semanticRouterRoute[]` |
| `semantic_router_latency_ms` (histogram) | `semanticRouter.semanticRouterLatencyMs` (+ `…EmbeddingMs`, `…ScoringMs`) |
| `semantic_router_confidence` (histogram) | `semanticRouter.semanticRouterConfidence` |
| `semantic_router_margin` (histogram) | `semanticRouter.semanticRouterMargin` |
| `semantic_router_fallback_rate` (derived) | `semanticRouter.semanticRouterFallbackRate` |

Percentiles are nearest-rank (`percentileNearestRank`), so every reported value is an observed
measurement and reconciles with `/admin/observability`'s latency figures.

### Latency, honestly

The epic's "50s → 10ms" is **not a claim this change can substantiate.** Two separate corrections:

- The 50s figure is a whole-turn number, not a router number. The router the semantic one replaces
  is the LLM intent classifier, whose *measured* live cost is **p50 1,263ms / p95 2,380ms /
  p99 3,662ms** (1,726 live-gate decisions, 14 days to 2026-08-25). That is the honest before-number.
- A **cold** semantic route still pays an OpenAI embedding round-trip (tens to hundreds of ms).
  Only `scoringMs` — the cosine pass — and a warm cache hit (`embeddingMs === 0`) are in single-digit
  ms. That is why `latencyMs` is reported split into `embeddingMs + scoringMs` everywhere, and why no
  test asserts a cold call under 10ms. **Never quote a warm p50 as the general case.**

---

## 3. Rollout stages

Each stage ends with a Go/No-Go read of §4. Nothing below has been executed — this is the plan.

**Stage 0 — baseline (done, 2026-08-25).** See §4.5.

**Stage 1 — shadow, 48h.** `ENABLED=true`, `SHADOW_MODE=true`.
The semantic router runs on every orchestrator turn and is fully logged; the LLM classifier still
decides. Note that shadow mode **adds** the router's latency to the turn (the call is awaited, not
raced against the tool loop). That is deliberate: B0-511 learned that a concurrent shadow call hides
its own latency and timeouts, so a shadow stage measured that way cannot answer the cutover
question. Read §4.1–4.4. Go requires all four gates green.

**Stage 2 — live cutover, 48h intensive then 1 week watch.** `ENABLED=true`, `SHADOW_MODE=false`.
The semantic router decides; the LLM classifier is not called except on a fallback. Re-read
§4.1–4.4 at +2h, +24h, +48h, then daily for a week.

**Stage 3 — steady state.** Leave `BEX_LLM_ROUTER_ENABLED=true`. It costs nothing while the
semantic path is healthy (the classifier is not called) and it *is* the fallback in §1 row 2.

---

## 4. Monitoring queries

All queries below were executed against the live database on 2026-08-25 and run clean. Windows are
`interval '48 hours'`; widen as needed. `/admin/observability` and `/admin/bex/health` render the
same numbers via the `routing-health.ts` reducers — the SQL is here so an operator can read them
without the UI.

### 4.1 Fallback rate + latency percentiles (`semantic_router_fallback_rate`, `semantic_router_latency_ms`)

```sql
with semantic as (
  select
    g->>'gate'                                      as gate,
    g->'inputs'->>'semanticRoute'                   as route,
    g->'inputs'->>'semanticPath'                    as path,
    (g->'inputs'->>'semanticConfidence')::numeric   as confidence,
    (g->'inputs'->>'semanticMargin')::numeric       as margin,
    (g->'inputs'->>'semanticLatencyMs')::numeric    as latency_ms,
    (g->'inputs'->>'semanticEmbeddingMs')::numeric  as embedding_ms,
    (g->'inputs'->>'semanticScoringMs')::numeric    as scoring_ms,
    g->'inputs'->>'semanticError'                   as error
  from public.workflow_steps s
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(s.output->'gates') = 'array' then s.output->'gates' else '[]'::jsonb end
  ) g
  where s.step_name = 'orchestration_planner'
    and s.started_at >= now() - interval '48 hours'
    and g->>'gate' in ('semantic_router_live', 'semantic_router_shadow')
)
select
  count(*)                                                               as decisions,
  count(*) filter (where gate = 'semantic_router_live')                   as live_decisions,
  count(*) filter (where path = 'fallback')                              as fallbacks,
  round(count(*) filter (where path = 'fallback')::numeric
        / nullif(count(*), 0), 4)                                        as fallback_rate,
  percentile_disc(0.5)  within group (order by greatest(latency_ms, 0))   as p50_latency_ms,
  percentile_disc(0.95) within group (order by greatest(latency_ms, 0))   as p95_latency_ms,
  percentile_disc(0.99) within group (order by greatest(latency_ms, 0))   as p99_latency_ms,
  percentile_disc(0.5)  within group (order by greatest(embedding_ms, 0)) as p50_embedding_ms,
  percentile_disc(0.95) within group (order by greatest(embedding_ms, 0)) as p95_embedding_ms,
  percentile_disc(0.5)  within group (order by greatest(scoring_ms, 0))   as p50_scoring_ms
from semantic;
```

`greatest(…, 0)` clamps rather than filters: a dropped sample silently shrinks the denominator of
every percentile beside it. (Router latencies come from one Node clock so they should never be
negative — unlike `workflow_steps` durations, where `started_at` is Postgres `now()` and
`completed_at` is the Node clock, and fast steps genuinely compute negative.)

### 4.2 Route distribution and fallback reasons (`semantic_router_route`)

```sql
with semantic as (
  select
    g->'inputs'->>'semanticRoute'      as route,
    g->'inputs'->>'semanticPath'       as path,
    g->'inputs'->>'routingDecision'    as routing_decision,
    coalesce(g->'inputs'->>'semanticError', 'thresholds_not_met') as error,
    (g->'thresholds'->>'confidenceThresholdPassed')::boolean      as confidence_passed,
    (g->'thresholds'->>'marginThresholdPassed')::boolean          as margin_passed
  from public.workflow_steps s
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(s.output->'gates') = 'array' then s.output->'gates' else '[]'::jsonb end
  ) g
  where s.step_name = 'orchestration_planner'
    and s.started_at >= now() - interval '48 hours'
    and g->>'gate' in ('semantic_router_live', 'semantic_router_shadow')
)
select route, path,
       count(*)                                                     as decisions,
       count(*) filter (where path = 'fallback')                    as fallbacks,
       min(case when path = 'fallback' then error end)              as example_reason,
       round(avg(case when confidence_passed then 1 else 0 end), 4)  as confidence_pass_rate,
       round(avg(case when margin_passed then 1 else 0 end), 4)      as margin_pass_rate,
       round(avg(case when route = routing_decision then 1 else 0 end), 4) as agreement_with_actual
from semantic
group by route, path
order by decisions desc;
```

A fallback rate driven by `thresholds_not_met` is a **tuning** problem (raise example coverage or
lower `SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD` / `SEMANTIC_ROUTER_MARGIN_THRESHOLD`). One driven by an
`error` string is an **infrastructure** problem (embedding API, initialization) — abort, do not tune.

### 4.3 Routing accuracy vs the B0-497 baseline

Run the eval harness suites on `/admin/tests` (the routing suites carrying `intended_agent_label`),
then:

```sql
select
  count(*) filter (where intended_agent_label is not null)                          as labeled_items,
  round(count(*) filter (where intended_agent_label is not null
                           and keyword_route = intended_agent_label)::numeric
        / nullif(count(*) filter (where intended_agent_label is not null), 0), 4)   as keyword_accuracy,
  round(count(*) filter (where intended_agent_label is not null
                           and llm_route = intended_agent_label)::numeric
        / nullif(count(*) filter (where intended_agent_label is not null), 0), 4)   as llm_accuracy,
  round(count(*) filter (where intended_agent_label is not null
                           and semantic_route = intended_agent_label)::numeric
        / nullif(count(*) filter (where intended_agent_label is not null
                                    and semantic_route is not null), 0), 4)         as semantic_accuracy,
  count(*) filter (where semantic_route is not null)                                as semantic_scored_items
from public.test_result_items
where created_at >= now() - interval '7 days';
```

`semantic_accuracy` is scored per *scored* item (its own denominator), so an item the semantic
router never scored cannot deflate it.

### 4.4 "I don't know" uptick and answer quality

```sql
select
  count(*)                                                        as runs,
  count(*) filter (where final_output->>'answerProvenance' = 'decline_gate') as decline_gate,
  round(count(*) filter (where final_output->>'answerProvenance' = 'decline_gate')::numeric
        / nullif(count(*), 0), 4)                                 as decline_rate,
  count(*) filter (where final_output->>'answerText' ~*
    '(i (do not|don''t) know|could not (fully )?verify|unable to (find|locate|confirm)|no (information|data) (available|found))')
                                                                  as idk_answers,
  round(count(*) filter (where final_output->>'answerText' ~*
    '(i (do not|don''t) know|could not (fully )?verify|unable to (find|locate|confirm)|no (information|data) (available|found))')::numeric
        / nullif(count(*), 0), 4)                                 as idk_rate,
  round(avg(confidence)::numeric, 4)                              as avg_confidence,
  round(count(*) filter (where final_output->>'routingDecision' = 'ambiguous')::numeric
        / nullif(count(*), 0), 4)                                 as ambiguous_rate
from public.workflow_runs
where workflow_name = 'product-support'
  and status = 'completed'
  and created_at >= now() - interval '48 hours';
```

The `idk` regex is a **proxy**, not a classifier; treat a change in it as a prompt to read a sample
of answers, not as a verdict on its own.

### 4.5 Baselines measured 2026-08-25 (pre-rollout)

| Metric | Value | Window / source |
|---|---|---|
| LLM classifier live decisions | 1,726 | 14 days, `llm_intent_classifier_live` gates |
| LLM classifier fallback rate (`classifierSource='keyword_fallback'`) | **0.58%** | same |
| LLM classifier latency p50 / p95 / p99 | **1,263 / 2,380 / 3,662 ms** | same |
| Completed product-support runs | 2,852 | 14 days, `workflow_runs` |
| Decline-gate share | 5.22% (149) | same |
| "I don't know"-shaped answers | 0.21% (6) | same |
| Mean run confidence | 0.8699 | same |
| Routing accuracy — LLM (`llm_route` vs `intended_agent_label`) | **0.6138** | 435 labeled `test_result_items`, 30 days |
| Routing accuracy — keyword | 0.1724 | same |
| Semantic decisions recorded | 0 | flag off |

Query 4.4 over its own **48-hour** window (the window the rollout reads) on the same day, for a
like-for-like comparison — the numbers differ from the 14-day row above, which is the point:

| Metric | 48h value |
|---|---|
| Completed runs | 228 |
| Decline-gate share | 3.51% (8) |
| "I don't know"-shaped answers | 0.44% (1) |
| Mean run confidence | 0.8255 |
| `ambiguous` routing share | 26.75% |

**The `idk` proxy is single-digit-count noise at 48h** (1 answer of 228). Do not treat a change in it
as a signal below ~10 matches; read a sample of answers instead. The `ambiguous_rate` of 26.75% is
the number worth watching — it is high already, and reducing it is much of the semantic router's
point.

---

## 5. Abort thresholds

Abort (§6) if **any** of these holds on a Stage 1 or Stage 2 read, once the window has at least
**200 semantic decisions** (below that, prefer waiting over acting on noise):

| Signal | Query | Abort at |
|---|---|---|
| Fallback rate | 4.1 `fallback_rate` | **> 0.20** (the ticket's target is < 20%) |
| Fallback rate driven by an infrastructure `error` | 4.2 `example_reason` | **> 0.05** of decisions on any non-`thresholds_not_met` reason |
| Routing accuracy | 4.3 `semantic_accuracy` | **< 0.6138** (the measured B0-497 LLM baseline), i.e. any regression |
| Router latency | 4.1 `p95_latency_ms` | **> 2,380 ms** (the measured LLM classifier p95 — the semantic router must not be slower than what it replaces) |
| "I don't know" uptick | 4.4 `idk_rate` | **≥ 10 matches AND ≥ 2×** the Stage 0 48h rate (0.0044). Below 10 matches this is noise — read a sample of answers, do not abort on it |
| Ambiguous routing uptick | 4.4 `ambiguous_rate` | more than **+5 pp** vs the Stage 0 48h read (0.2675) |
| Mean run confidence | 4.4 `avg_confidence` | drop of more than **0.05** vs the Stage 0 48h read (0.8255) |

Stage 1 (shadow) cannot regress routing at all — a Stage 1 abort means "do not proceed to Stage 2",
not "roll back production".

---

## 6. Rollback

**One row, one flip. No deploy, no code change, no data migration.**

1. `/admin/settings` → set **`BEX_SEMANTIC_ROUTER_ENABLED`** to `false`.
   (Or `update public.settings set value = 'false' where key = 'BEX_SEMANTIC_ROUTER_ENABLED';`)
2. Wait up to **30 seconds** for the settings cache (`CACHE_TTL_MS`) to expire on warm servers.
3. Confirm: query 4.1 over `interval '10 minutes'` should return `decisions = 0`, and
   `workflow_runs.final_output.runtimeConfig.semanticRouterEnabled` should read `false` on new runs.

Blast radius of the rollback: **routing only.** Every turn returns to the LLM intent classifier
(`BEX_SEMANTIC_ROUTER_ENABLED=false` is §1 row 4, which is byte-identical to the pre-B0-649 code
path). No prompt, tool schema, retrieval or confidence behaviour changes beyond whatever follows
from the route label itself. In-flight turns finish under the flag state they started with.
Historical `semantic_router_*` gate records are left in place — they are the rollout's evidence.

Intermediate option instead of a full rollback: set **`BEX_SEMANTIC_ROUTER_SHADOW_MODE=true`**. The
router keeps running and logging (so tuning can continue against live traffic) but stops deciding.
This still costs the router's latency per turn, so it is a diagnosis posture, not a resting state.

If the *fallback* itself is implicated, `BEX_LLM_ROUTER_ENABLED=false` additionally demotes routing
to the keyword router, exactly as it did before this work.

---

## 7. Known narrowing to watch

When the semantic router decides a turn, the cross-reference-intent verdict
(`crossReferenceIntentForTurn`) is `semanticRoute === 'recommendations' OR` the legacy keyword
substring check. The semantic decision has no `suggestedTool` counterpart, so the B0-339 signal
("a cross-reference `suggestedTool` on a turn that routed to another specialist") is unavailable on
this path. Keeping the substring check as an `OR` is the conservative direction — it cannot *lose* a
cross-reference the old world caught — at the cost of retaining that check's known false positives.
If forced cross-reference lookups rise on the semantic path, this is the first place to look:

```sql
select final_output->>'routingDecision' as route,
       count(*) as runs,
       count(*) filter (where final_output->'runtimeConfig'->>'semanticRouterDecided' = 'true') as semantic_decided
from public.workflow_runs
where workflow_name = 'product-support'
  and created_at >= now() - interval '48 hours'
group by 1
order by runs desc;
```

---

## 8. What is NOT done here

- **48h–1w of production monitoring, and the Go/No-Go decision.** Documented and ready; not
  executed. Requires live traffic with the flag on.
- **"Latency improvement confirmed."** Not confirmable from a code change — it needs Stage 1 data
  from a real deploy. §4.5 records the before-numbers so the comparison is possible; the "50s → 10ms"
  framing is corrected in §2.
- **"No eval regression."** The harness query (4.3) is written and the baseline is captured, but the
  suites have to be *run* with `BEX_SEMANTIC_ROUTER_ENABLED=true` to produce `semantic_route` rows.
- **Percentage cohorting.** Deliberately not built (§1).
