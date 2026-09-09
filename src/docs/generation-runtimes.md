# Generation runtimes — decision record (B0-378)

Status: **accepted, both runtimes stay** — 2026-08-26.
Scope: the agent loop inside `runProductSupportWorkflow` only. The wider migration is
[`vercel-ai-sdk-migration-plan.md`](./vercel-ai-sdk-migration-plan.md); this record covers the one
fork that plan created and the fidelity gap it left behind.

## The two runtimes

| | Responses loop | AI SDK loop |
| --- | --- | --- |
| File | `~/lib/openai/responses-runtime.ts` | `~/lib/bex/ai-sdk-runtime.ts` |
| Entry | `runResponsesWithToolLoop` | `runAiSdkWithToolLoop` |
| Transport | OpenAI SDK Responses API | Vercel AI SDK `streamText` |
| Multi-turn memory | server-side, via `previous_response_id` chaining | stateless, history replayed every call |
| Status | **canonical / production default** | opt-in, off by default |

Both are called from the same fork in
`~/lib/workflows/product-support/run-product-support-workflow.ts`, share the same `executeTool`
closure, and return the same `{ assistantText, finalResponseId, toolTrace, responseIds, usage,
usageByCall }` shape. The AI SDK path has no OpenAI response id, so the workflow substitutes a
synthetic `ai_sdk:<runId>` where `latest_openai_response_id` would go.

## The flag

`BEX_AI_SDK_GENERATION_ENABLED` — **read from the `settings` table, not `process.env`.**

```ts
// run-product-support-workflow.ts:1509
const useAiSdkGeneration = await getBooleanSetting('BEX_AI_SDK_GENERATION_ENABLED', false);
```

It was migrated out of the environment by B0-638 and is now editable at `/admin/settings`
(`~/components/admin/settings/SettingsPanel.tsx`), seeded `false` by
`20260820170000_create_settings_table.sql`. No redeploy is needed to flip it, and nothing reads an
env var of that name any more. Any doc or ticket still describing it as an env flag is stale.

## Why both stay (for now)

- The Responses loop is the production default and carries a large amount of hard-won behaviour that
  the AI SDK loop does not yet reproduce: the B0-635 unproductive-retrieval early stop, the B0-381
  tool-rounds-exhausted forced final answer, the B0-606 temperature-rejection replay, and
  `previous_response_id` chaining itself (which is also the cheaper path — the stable prefix stays
  prompt-cached server-side instead of being re-sent).
- Deleting it is a cutover, not a refactor, and would have to be run and measured, not reasoned
  about. That is deliberately out of this ticket's scope.
- The organisation has an in-flight AI SDK migration, so the second runtime is a live destination,
  not dead code.

The cost of keeping both is real and acknowledged: every change to the agent loop has to be made
twice, and the two can drift. This record plus the parity tests below is how that is contained.

## Fidelity: what each path carries today

| Prior-turn information | Responses (chained) | Responses (chain broken) | AI SDK |
| --- | --- | --- | --- |
| User + assistant text | yes (server-side) | yes, replayed | yes, replayed |
| Tool call names | yes, verbatim | summary (B0-378) | summary (B0-378) |
| Tool call **arguments** | yes, verbatim | no | no |
| Tool **results** (full payloads) | yes, verbatim | no | no |
| Retrieved document titles | yes, inside the payloads | summary (B0-378) | summary (B0-378) |
| Turn count before capping | unbounded chain | `BEX_HISTORY_MAX_MESSAGES` (12) | `BEX_HISTORY_MAX_MESSAGES` (12) |

"Chain broken" is the B0-519 case: once a conversation exceeds the history cap, the Responses path
stops chaining and replays the capped tail as explicit messages, exactly as the AI SDK path always
does. From that point the two paths are assembled identically — that symmetry is the point.

### Why a summary and not real tool parts

Before B0-378 the AI SDK path replayed user/assistant **text only**, so every prior turn's tool
activity silently vanished. It is now restored as a compact, self-labelling block
(`formatPriorTurnToolContext`, in `responses-runtime.ts` alongside `formatPreloadedEvidence` so both
runtimes emit byte-identical text), injected as its own `user` message directly after the assistant
turn it describes.

It is a summary because that is all that is recoverable. A persisted assistant message
(`agent_messages.content`, `assistantMessageContentSchema`) stores:

- `toolSummary: [{ name, ok }]` — tool names and success flags, in execution order
- `sources: [{ documentId, title, snippet, … }]` — the documents that turn cited

The tool **arguments** and tool **outputs** are not on the message at all. The only surviving copy is
the truncated `argumentsPreview` (1.8k chars) / `outputPreview` (4k chars) on the `workflow_steps`
row's persisted `toolTrace`. Reconstructing genuine AI SDK tool-call / tool-result parts from that
would mean inventing tool-call ids and presenting a silently-truncated preview as the full payload —
and a model that believes it holds a whole label is exactly how an unsupported dilution ratio or
contact time gets asserted. An inaccurate replay is worse than a summarised one.

For the same reason the block carries document **titles only, never snippets**: a snippet is a
fragment of a regulated document with its qualifiers stripped, and re-injecting fragments turn after
turn invites exactly the quoting this codebase must not do. The block says plainly that it holds no
dilution, ppm, contact time, EPA/CAS number or log-reduction value, and tells the model to call the
tool again if it needs one.

### Where the summary is built

`~/lib/bex/run-chat-turn.ts` (`buildPriorTurnHistory` / `buildPriorTurnToolContext`) — the only layer
that has the persisted rows in hand. It replaces the old text-only `{ role, content }` mapping.

One wire detail: `runProductSupportWorkflow`'s `priorMessages` parameter is still declared as
`Array<{ role; content }>`, so `toolContext` currently travels as an extra property that
`capConversationHistory`'s shallow copy preserves. It reaches both runtimes intact and is dropped by
every other consumer — `priorTurnsForRouting` re-maps to `{ id, role, content }`, so the LLM intent
classifier and the semantic router see the same clean text as before and **no routing decision
moves**. Widening that parameter (and `capConversationHistory`'s return type) to
`ReplayedHistoryMessage[]` is a one-line follow-up that makes the contract explicit.

## Parity coverage

Unit tests, not an `/admin/tests` harness run (the harness was owned by another change at the time):

- `~/lib/bex/ai-sdk-runtime.test.ts` — "prior-turn tool context replay (B0-378)": the constructed
  message array carries the block right after its assistant turn; no fabricated `tool-call` /
  `tool-result` parts or `tool`-role messages ever appear; a turn with no tool activity adds nothing.
- `~/lib/openai/responses-runtime.test.ts` — "prior-turn tool context (B0-378)": a live
  `previousResponseId` still replays **no** history and no block (chaining unchanged); the
  chain-broken path emits the identical block in the identical position.
- `~/lib/bex/run-chat-turn.test.ts` — the summary is derived from persisted content, deduped, capped,
  snippet-free, and reaches `runProductSupportWorkflow`.

A live A/B parity eval in `/admin/tests` (same question set, both runtimes, compared answers) is the
follow-up that would let the flag be flipped with evidence rather than judgement.

## Before the Responses loop can be deleted

1. ~~Port the Responses-only loop behaviours: B0-635 unproductive-retrieval withdrawal, B0-381
   tool-rounds-exhausted forced answer, B0-606 temperature-rejection replay.~~ **Done (B0-901,
   2026-09-08)** — see "Ported loop behaviours" below.
2. Decide what replaces `previous_response_id` chaining — the AI SDK path pays full prompt cost per
   turn, so the cost/latency delta has to be measured on real conversations, not assumed.
3. Run the `/admin/tests` parity eval above and hold it green across the golden sets.
4. Retire `latest_openai_response_id` (or accept the synthetic `ai_sdk:<runId>` marker permanently)
   and everything downstream that reads it.
5. Flip `BEX_AI_SDK_GENERATION_ENABLED` on in production, soak, then delete.

Until step 3 exists, "which runtime answers better" is an opinion, and the default stays Responses.

## Ported loop behaviours (B0-901)

B0-898 made the AI SDK loop the only path a Claude model can answer on, which turned the fidelity
gap above into a measurement problem: with OpenAI on the Responses loop and Anthropic on the AI SDK
loop, a score difference mixed the model with the runtime. All three behaviours are now on both
loops, from **one** copy of each string — they are exported from `responses-runtime.ts` and imported
by `ai-sdk-runtime.ts`, the same rule `formatPreloadedEvidence` and `formatPriorTurnToolContext`
already follow.

| Behaviour | Responses loop | AI SDK loop |
| --- | --- | --- |
| B0-635 withdrawal | per-round scoring, `roundTools` filter, notice with the tool outputs | scored in the tool `execute` closure, `prepareStep` returns `activeTools` minus `RETRIEVAL_TOOL_NAMES` + the notice |
| B0-381 forced answer | post-loop request with `tool_choice: 'none'` | `stopWhen: stepCountIs(maxToolRounds + 1)`, final step forced to `toolChoice: 'none'` |
| B0-606 temperature replay | replay without `temperature` on rejection | not reachable: this loop never sends a sampling control (asserted in its tests) |

Shared strings: `RETRIEVAL_EXHAUSTED_INSTRUCTION`, `TOOL_ROUNDS_EXHAUSTED_INSTRUCTION`,
`TOOL_ROUNDS_EXHAUSTED_FALLBACK_TEXT`. Shared scoring: `collectRetrievalEvidenceIds`,
`isCorpusSearchPayload`, `RETRIEVAL_TOOL_NAMES`, `UNPRODUCTIVE_RETRIEVAL_CALL_LIMIT`.

**One deliberate divergence, in B0-381.** The Responses loop does not execute the tools requested on
the final round; it answers each pending call with `TOOL_ROUNDS_EXHAUSTED_TOOL_OUTPUT` ("this call
was not executed") to keep the `previous_response_id` chain valid, then forces the answer. The AI SDK
owns tool execution inside the step, so by the time `prepareStep` can intervene those calls have
already run and their real outputs are in the message list. The model-visible INSTRUCTION is
byte-identical either way — which is what an A/B compares — and the divergence costs a pathological
run one extra round of tool work it did not need. `TOOL_ROUNDS_EXHAUSTED_TOOL_OUTPUT` therefore has
no AI SDK equivalent and is not exported for one.

Parity tests: `ai-sdk-runtime.test.ts` → "ported loop behaviours (B0-901)", mirroring the fixtures in
`responses-runtime.test.ts` → "tool-round exhaustion (B0-381)", "unproductive-retrieval early stop
(B0-635)" and "temperature gating (B0-606)".

## Post-generation gate: regulated-claim guardrail — redact vs. decline (B0-829 / B0-871)

Both runtimes feed the same post-generation gates in
`~/lib/workflows/product-support/run-product-support-workflow.ts`. When `evaluateRegulatedClaimGrounding`
(`validator.ts`) reports an ungrounded regulated claim, `validation` is always forced to
`approved: false`, `confidence ≤ 0.4`, `requires_human_review: true`. What the USER sees is decided by
`planRegulatedClaimRedaction`, in this order:

1. Any ungrounded `hazard` or `first_aid` → full decline (`answerProvenance: validator_fallback`). Always.
2. Every ungrounded category token-shaped (`epa_registration`, `din_registration`, `dilution_ratio`,
   `contact_time`, `cas_number`) → **B0-829 token redaction**: each snippet is `replaceAll`'d with
   `(unable to verify)`, provided at least one other detected category on the draft was grounded;
   otherwise decline (`nothing_grounded_to_keep`).
3. Otherwise (`compatibility` / `efficacy_claim` ungrounded) → **B0-871 sentence redaction**, ONLY when
   the question is not product-usage-specific — no `productLineLock.lockedProductLineKey`, OR
   knowledge-kind sources are strictly more than half of the retrieved sources with a known
   `documentKind` — AND substantive content remains (≥ 120 letters/digits outside the markers). Each
   ungrounded sentence is replaced verbatim by
   `[one <category label> withheld — not verifiable against a retrieved label]`; a snippet the
   validator cut at 240 chars is first expanded to the whole sentence using the validator's own
   sentence boundary (`(?<=[.!?])\s+(?=[A-Z0-9])` or newline), so no tail of the claim survives. A
   snippet that is not a verbatim substring of the draft → decline (`snippet_not_found_in_draft`);
   the removed sentence is never rephrased.

Both redaction shapes report `answerProvenance: regulated_claim_partial_redaction`,
`activeGates.regulatedClaimGuardrail = { state: 'ran', verdict: 'redacted' }` and
`gates[regulated_claim_guardrail].inputs.redactionMode` (`token_redaction` | `sentence_redaction`);
a decline reports `verdict: 'rejected'` with `inputs.declineReason`. The
`regulated_claim_guardrail_rejected` audit row carries the same `outcome` / `declineReason`.

**Status: the B0-871 rule (step 3) is the ticket's PROPOSED policy, implemented as the default pending
Tom Bird's confirmation.** B0-829 had excluded all four sentence-shaped categories by design, decided
against a contact-time example and never tested on knowledge answers; 34 of the 57 F-graded golden items
were the same 255-char decline replacing a draft that held the golden's mandatory concepts because of one
unverifiable compatibility/efficacy sentence. To revert to B0-829 behaviour, empty
`REDACTABLE_SENTENCE_REGULATED_CATEGORIES`.

Related: the usage/safety coverage gate (B0-872) now requires an identifiable product subject
(`resolveUsageSafetyProductSubject`: product-line lock, signals-resolved product, or a `productName` tool
argument) in addition to a usage/safety-shaped question, and its lexical predicate no longer fires on bare
`dilution` / `application`. A usage-shaped question naming no product is recorded as
`usageSafetyCoverage: { state: 'not_applicable', reason: 'no_product_subject' }` and the draft is kept.
`isSafetySensitiveRoute` (B0-546 validator-skip) deliberately keeps the broad pre-B0-872 predicate.
