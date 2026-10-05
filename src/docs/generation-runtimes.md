# Generation runtime — decision record (B0-914)

Status: **one loop. The OpenAI Responses loop and the `BEX_AI_SDK_GENERATION_ENABLED` selector were
removed in B0-914 (2026-10-05).** This record supersedes the B0-378 "both runtimes stay" decision
(2026-08-26). Scope: the agent loop inside `runProductSupportWorkflow` only.

## The decision

Every turn, on every provider, runs on the AI SDK `streamText` loop
(`~/lib/bex/ai-sdk-runtime.ts`, entry `runAiSdkWithToolLoop`). The Responses-API loop
(`runResponsesWithToolLoop`), the workflow fork that chose between them, the `previous_response_id`
chain and the settings row are gone. Shared types and helpers live in
`~/lib/llm/generation-shared.ts`.

Why: two loops meant every loop change had to be made twice, a vendor comparison was also a runtime
comparison (B0-909), and the provider seam (B0-898) could not make vendor choice a pure settings
row while one vendor was locked to one loop. The recorded decision was taken by Tom Bird on
2026-10-05 after the evidence below.

## Evidence

- **Quality, same model, same grader** (gpt-4.1, 114 golden items, opus-5 grading). On the same
  code (2026-09-30): Responses 90/114, AI SDK 91/114, 109 of 114 items agreeing. On today's code:
  Responses 88/114 against AI SDK 86 and 87 (two identical AI SDK passes flip only 3 items between
  themselves), i.e. a gap inside run-to-run spread. Ledgers `7914dcc0`, `e02767f3` (Sep 30) and
  `0c945d89`, `27f96013`, `fc2dede6` (Oct 5).
- **A real regression found and fixed on the way (B0-1138).** The AI SDK loop sent no
  `temperature` while the Responses loop sent 0.2, so OpenAI used its default of 1.0 on the AI SDK
  path. Drafts were looser, added specific contact times the regulated-claim guardrail could not
  ground, and guardrail redactions rose from 4 to 9. Both loops now share
  `DEFAULT_GENERATION_TEMPERATURE` through `samplingParamsFor`; redactions fell to 6 and 7 against
  8 on Responses.
- **Cost and latency, single turn** (the B0-1136 numbers): average prompt 27.4k vs 28.0k tokens,
  cached share 36.3% vs 32.8%, TTFT 5.8s vs 6.6s, elapsed 10.2s vs 11.8s.
- **Cost, multi turn:** only 51 of 22,860 conversations (0.2%) have two or more user turns. On the
  Responses chain, prompts grew from 17k tokens (turn 1) to 32k, 35k, 44k and 55k by turn 5 while
  the cached share stayed at 35-49%, so chaining bought little caching. A stateless replay adds
  about 700 tokens per prior turn (modelled from measured parts, not a live multi-turn run).

## What changed in behaviour

- **No server-side memory.** Multi-turn memory is the replayed history (`priorMessages`, capped at
  `BEX_HISTORY_MAX_MESSAGES`, 12 by default) plus the B0-378 tool-context summary. Prior full tool
  payloads are not carried; a follow-up that needs one re-calls the tool.
- **`latest_openai_response_id`** is kept as a column and always holds the synthetic
  `ai_sdk:<runId>`. Dropping it would be a migration across conversations, schemas and generated
  types for no functional gain; revisit as its own cleanup.
- **Historical records still read correctly.** `GenerationRuntime` keeps the value `responses`, and
  `runtimeConfig.aiSdkGenerationEnabled`, `previousResponseId` and the agent step's
  `hasPreviousResponse` are optional/legacy so runs written before the cutover still parse and
  render.
- **Per-attempt request timeout.** The AI SDK loop bounds request-to-first-chunk on OpenAI models
  (B0-550 parity, `resolveOpenAiRequestTimeoutMs`); Claude is deliberately unbounded there because
  adaptive thinking can legitimately exceed it.
- **Rollback is a code revert.** There is no flag to flip back.

## Loop behaviours carried over from the retired Responses loop

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


## Behaviour audit of the retired loop (B0-1137)

Every behaviour the Responses loop carries, and where the AI SDK loop stands. Checked in code and
asserted by a test where one exists.

| Behaviour | Responses loop | AI SDK loop | Status |
| --- | --- | --- | --- |
| B0-635 unproductive-retrieval withdrawal | yes | yes | ported (B0-901) |
| B0-381 forced final answer | yes | yes | ported (B0-901), with the divergence below |
| B0-606 temperature-rejection replay | yes | yes | **ported (B0-1138)** — see temperature below |
| B0-370 bounded transport retry | `retryTransportFaults` | same function, per `doStream` | present |
| B0-550 per-attempt request timeout | `timeout: resolveOpenAiRequestTimeoutMs()` | first-chunk timeout in the retry middleware | **ported (B0-1137)**, OpenAI only |
| B0-379 parallel tool calls | `parallel_tool_calls: true` + `Promise.all` | SDK runs a step's calls concurrently | present, asserted by test (B0-1137) |
| B0-948 fact-tool enforcement | yes | yes | present, same contract |
| B0-512 `suggestedFirstTool` round-0 bias | implemented | absent | **dead**: nothing in production passes a `suggestedFirstTool` (see `speculative-retrieval.ts`), so there is nothing to port |

Decisions recorded:

- **B0-550 on Claude is deliberately not bounded.** The timeout covers request-sent to first-chunk
  and is applied to OpenAI models only: Claude's adaptive thinking can legitimately run past the
  60s default before its first token, and B0-550 was an OpenAI stall. A timeout is classified as a
  retryable `timeout` fault and goes through the normal bounded retry. The timer is cleared at the
  first chunk, so a long answer is never cut off.
- **B0-381 extra round (accepted).** The AI SDK executes the final round's tool calls before the
  forced answer; the Responses loop skips them. The model-visible instruction is identical.
- **Temperature (was wrongly "accepted", fixed in B0-1138).** The Responses loop has always sent
  `temperature: 0.2` to models that accept it; the AI SDK loop sent none, so OpenAI used its own
  default of 1.0. On the gpt-4.1 A/B (B0-1122) the AI SDK arm drafted more freely, added specific
  contact times the guardrail could not ground, and took `regulated_claim_partial_redaction` on
  items where Responses answered `model_generated` (guardrail redactions 4 -> 9). Both loops now
  send `DEFAULT_GENERATION_TEMPERATURE` (`~/lib/openai/model-capabilities`) through the same
  `samplingParamsFor` gate, and the AI SDK loop has the same replay-once safety net for an
  unfamiliar model that rejects it. Claude ids and models verified to reject it still get none.


## Fidelity: what prior-turn information the model sees

| Prior-turn information | Now (AI SDK, stateless) | Before B0-914, Responses chained |
| --- | --- | --- |
| User + assistant text | yes, replayed | yes, server-side |
| Tool call names | summary (B0-378) | yes, verbatim |
| Tool call **arguments** | no | yes, verbatim |
| Tool **results** (full payloads) | no | yes, verbatim |
| Retrieved document titles | summary (B0-378) | yes, inside the payloads |
| Turn count before capping | `BEX_HISTORY_MAX_MESSAGES` (12) | unbounded chain until B0-519 |

The right-hand column is what the retired chain carried; the left is what the model sees now. The
trade is deliberate (see Evidence): the chain's extra payloads roughly doubled the prompt by turn 2
without a matching cache benefit.

### Why a summary and not real tool parts

Before B0-378 the AI SDK path replayed user/assistant **text only**, so every prior turn's tool
activity silently vanished. It is now restored as a compact, self-labelling block
(`formatPriorTurnToolContext`, in `~/lib/llm/generation-shared.ts` alongside
`formatPreloadedEvidence`), injected as its own `user` message directly after the assistant
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
`capConversationHistory`'s shallow copy preserves. It reaches the generation loop intact and is dropped by
every other consumer — `priorTurnsForRouting` re-maps to `{ id, role, content }`, so the LLM intent
classifier and the semantic router see the same clean text as before and **no routing decision
moves**. Widening that parameter (and `capConversationHistory`'s return type) to
`ReplayedHistoryMessage[]` is a one-line follow-up that makes the contract explicit.


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
