# Session handoff — remaining Bex 2.0 work (2026-07-15)

Handoff for continuing two initiatives. Everything below "Done" is on `dev`. **This session's last
three commits (B0-93, B0-39, B0-90) may be unpushed — run `git log origin/dev..dev` and push
first.**

## Working norms (do these every story)
- Verify: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm exec vitest run <path>`. Full suite is ~149 tests.
- Branch `dev`. Commit per story; end messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Jira: project **B0** (cloudId `470dfad4-eebc-4e9d-8ae1-395754110613`). Transitions: To Do 11, In Progress 21, PR Review 31, Done 41, Blocked 2. Assignee tbird = `712020:9af57f8a-a4df-40ea-8033-dd0c5f0f2b2d`. Update the tickets you work (transition Done + assign + a comment noting commit + AC coverage; be honest about partial AC).
- Contract-first (Zod at boundaries), dependency-inject collaborators so logic is unit-testable without DB/LLM/network.

## Gotchas (learned this session)
- `src/supabase/**` (migrations) is **gitignored** — a separate Supabase repo. Migrations still get written there for the record, but only the regenerated `src/types/supabase.*.ts` is committed here.
- **DDL**: use the Supabase management API — `POST https://api.supabase.com/v1/projects/gbkobtatfsjibkxebvdw/database/query` with `Authorization: Bearer $(claude mcp get supabase | grep -oE 'sbp_[a-f0-9]{40,}')`. The in-session `mcp__supabase__*` tools are stale/Unauthorized headless.
- Tables created via the management API in the `rag` schema **do not auto-grant `service_role`** — add `grant select,insert,update,delete on rag.<t> to service_role;` and `notify pgrst, 'reload schema';` or PostgREST 401s.
- Regenerate types with the same token as the access token: `SUPABASE_ACCESS_TOKEN=$TOKEN pnpm run types:supabase:rag` (or `:public`).
- PostgREST returns `numeric` columns as **strings** — coerce in mappers.

---

## Done this session (context for the remaining work)

**Recommendation engine (epics B0-76 data model, B0-77 engine, + surface B0-93) — all built + tested, dep-injected:**
- `src/lib/recommendations/`: `recommendation-schemas.ts` (Zod), `repository.ts` (create/get/list/updateStatus over `rag.cross_reference_recommendations` + `_candidates`), `recommend-cross-reference.ts` (`recommendCrossReference()` legacy-first → web path), `candidate-retrieval.ts` (`retrieveBetcoCandidates`), `confidence-scoring.ts` (`scoreRecommendation` + `gateRecommendation`, env `XREF_RECOMMENDATION_MIN_CONFIDENCE` default 0.80, `XREF_DECLINE_COPY`), `persist-recommendation.ts` (`runCrossReferenceRecommendation()` = compute + best-effort persist), `recommendation-prompt.ts` (B0-90: `buildCrossReferenceRecommendationPrompt`, `recommendationAnswerSchema`, `RECOMMENDATION_ANSWER_JSON_SCHEMA`).
- `src/lib/websearch/enrich-competitor-spec.ts` (B0-86: `enrichCompetitorSpec`, `enrichedCompetitorSpecSchema`, provenance).
- Tool wired: `recommend_cross_reference` in `tool-schemas.ts` + `definitions.ts` + `product-tools.ts` dispatch → `runCrossReferenceRecommendation`. Prompts (`product-support-prompts.ts`, `recommendations-specialist-system-prompt.ts`) route to it on a legacy miss.
- Design doc: `src/docs/cross-reference-recommendations.md`.

**Category-First taxonomy (epic B0-25) — done earlier this session:** `src/lib/category/` (`category-resolver.ts`, `taxonomy-repository.ts` `resolveCategoryFromDb`/`getProductsForCategory`, `product-linker.ts`, `category-router.ts`, `eval/`). `public.product_category` holds `metakeywords` (v1) + `betco_site` (88 nodes, authoritative) sources; `product_category_link` has 224 `betco_site_scrape` links. `BEX_TAXONOMY_SOURCE` default `betco_site`.

**Reusable building blocks (do NOT rebuild):**
- Cross-reference: `src/lib/tools/cross-reference-lookup.ts` — `lookupCrossReference` (returns `fallbackRecommended:true` when empty or top confidence < 0.75), `deriveCanonicalProductUrl`, `LegacyProductRow`/`LegacyProductDescrRow`.
- Normalization: `src/lib/text/normalization.ts` (B0-39: `normalizeLookupValue`, `tokenizeLookupValue`) — shared by cross-reference + category resolver.
- Web search: `src/lib/websearch/web-search-service.ts` (`WebSearchService.search({query,depth?,domains?,maxResults?})`, TTL cache + `estimateCost` + `WEBSEARCH_DB_CACHE_ENABLED` durable cache), `mock-provider.ts` (`MockWebSearchProvider`), `guardrails.ts` (rolling-window limiter).
- LLM structured output pattern: `src/lib/workflows/product-support/validator.ts` (Responses `text.format` json_schema, `store:false`, `temperature:0`) + `src/lib/openai/client.ts` (`getOpenAIClient`, `resolveResponsesModel`).
- Retrieval: `src/lib/rag/search.ts` `searchProductChunks` + `RagSearchMatch`; `src/lib/retrieval/product-knowledge.ts`.
- Repository pattern: `src/lib/conversations/workflow-repository.ts`; audit `src/lib/audit/audit-log.ts` `writeAuditLog`.
- Admin UI pattern: `src/components/admin/rag/DomainMetadataCard.tsx` + `/admin/products/rag/*` (paginated table/edit/persist via server actions); admin API route auth via `getServerSession(authOptions)` → 401 (see `src/app/api/admin/web-search/route.ts`).
- Prompt-category classifier scaffolding (reuse for products): `classify_prompt_category` RPC + `prompt-categories.ts`.
- Sync patterns: `sds-sync-actions.ts`, `src/lib/rag/generate-actions.ts`.
- Existing tester UI: `src/components/admin/ProductCrossReferenceTester.tsx` → `POST /api/admin/tools/product-cross-reference`.

---

## Remaining 7 tickets

### Recommendation epics (B0-78 prompting/guardrails, B0-79 surface)

**B0-91 — Guardrails: injection defense, anti-hallucination, safety, validator pass (5 pts).**
Harden the web-grounded recommendation. Build (likely `src/lib/recommendations/recommendation-guardrails.ts`):
- Treat fetched web `rawContent` as **untrusted data**: wrap/delimit it (e.g. fenced `<web_evidence>…</web_evidence>`) and instruct the model to ignore embedded instructions. **Test with a poisoned snippet** ("ignore previous instructions…") that must not change behavior.
- Grounding enforcement: drop any candidate whose `betcoProductKey`/`betcoProductLineKey` doesn't resolve to a real `legacy.products` row (no fabricated SKUs/URLs/EPA). Add a post-filter in the web path of `recommend-cross-reference.ts`.
- Safety: never assert dilution/contact-time/PPE/SDS specifics unless present in retrieved Betco docs (see `escalation-agent.md` context).
- Validator pass: run `runValidatorPass` (validator.ts) on the drafted recommendation; `requires_human_review` or low validator confidence → force decline + `status:'pending'` review.
Reuse: `validator.ts`, `XREF_DECLINE_COPY`. Wire into `recommend-cross-reference.ts` web path. Unit-test each rule (poisoned snippet, unresolved candidate dropped, validator-forced decline).

**B0-92 — Web-search cost/domain/rate guardrails in the recommendation path (3 pts).**
- Cap searches per recommendation (≤ 2), default `basic` depth, escalate to `advanced` only if first pass inconclusive.
- Optional config domain allowlist (competitor/manufacturer + EPA) applied via the existing `domains` param.
- Verify cache reuse (no duplicate provider calls within TTL for same query).
- Record per-recommendation estimated cost in the audit log; configurable daily/query budget guard short-circuits to a decline when exceeded.
Reuse: `WebSearchService` cache + `estimateCost` + `depth`/`domains`; `writeAuditLog`; `guardrails.ts`. Mostly changes in `recommend-cross-reference.ts` `fetchWeb` step + a small budget module. Test with mock provider (count calls, budget exceed → decline).

**B0-94 — Recommendation API endpoint + cross-reference tester enhancement (3 pts).**
- New `POST /api/admin/tools/cross-reference-recommend` (auth via `getServerSession`, Zod-validated body `{competitorProduct, competitorBrand?}`) → calls `runCrossReferenceRecommendation`, returns result + `recommendationId`. Mirror `api/admin/web-search/route.ts`.
- Enhance `ProductCrossReferenceTester.tsx`: when the legacy lookup returns `fallbackRecommended`, show a "Web-grounded recommendation" section — overall confidence vs threshold, each candidate with rationale, web evidence (source URLs + extracted spec), and answered/declined with the decline copy verbatim.
UI-heavy — needs visual QA.

### Product-taxonomy pipeline (epic B0-26)

**B0-35 — LLM classifier for unlinked/low-confidence products.** For products the deterministic linker (`product-linker.ts`) can't place, LLM-classify title/description → taxonomy node + confidence; low-confidence → review queue (not auto-committed). Write proposals to `product_category_link` with `source='classifier'`. Reuse the `classify_prompt_category`/`prompt-categories.ts` scaffolding. Version the prompt + node option set.

**B0-36 — Admin curation UI (review/approve/override/bulk re-assign).** Admin screen over `product_category_link`: view/approve/edit/bulk-reassign product↔node links; filter low-confidence + unlinked queues; overrides flagged human-curated and never silently changed by a re-run. Mirror `DomainMetadataCard` + `/admin/products/rag`. UI-heavy — visual QA.

**B0-37 — Continuous delta sync on product add/update.** Sync job that re-runs linking on only new/changed products; idempotent/replay-safe; **preserves human-curated overrides** across syncs. Follow `sds-sync-actions.ts` / `generate-actions.ts` patterns — don't invent a new sync mechanism.

**B0-38 — Cross-validation report vs legacy catalog + live website categories.** On-demand reconciliation report: unlinked, multi-linked, and site-disagreement products (compare `product_category_link` vs legacy + live betco.com category pages — the site is server-rendered, scrape pattern already used for B0-33/B0-34). Diffable artifact; discrepancies link back to product + node.

## Suggested order
Recommendation epics first (they complete what's built): B0-91 → B0-92 → B0-94. Then taxonomy pipeline: B0-35 → B0-37 → B0-38 → B0-36 (B0-36 last since it depends on classifier proposals existing and is the biggest UI). B0-36 + B0-94 tester need human visual QA.
