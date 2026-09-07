import { z } from 'zod';

import { BEX_CHAT_AGENT_MODES, DEFAULT_BEX_CHAT_AGENT_MODE } from '~/lib/agents/agent-registry';
import supportedModels from '~/lib/constants/models';

/**
 * Request body for `POST /api/admin/tests/runs` (B0-465). Lives here rather than in the route file
 * because Next.js App Router `route.ts` modules may only export HTTP handlers / segment config, and
 * this contract needs to be unit-testable (B0-880).
 *
 * The parsed body feeds `buildTestRunOptions` (`~/lib/tests/run-config`) so the persisted
 * `test_results.run_options` blob is byte-identical to what `runTestAction` writes for the same
 * choices — the executor reads both back through the one `parseTestRunConfig` reader.
 *
 * The search-mode flags default to `false`, matching an unchecked checkbox in the admin form, so a
 * caller that omits them gets the same run the UI would produce. CI passes them explicitly.
 */
const supportedModelNames = supportedModels.map((m) => m.name);

export const createRunBodySchema = z.object({
  testId: z.string().min(1),
  runMode: z.enum(['full', 'search']).default('full'),
  /**
   * Maps to a concrete chat model in `resolveResponsesModel()`.
   *
   * B0-757 — defaults to `gpt-4.1`, not `preview`. This route is the CI eval-gate's run-creation
   * call (B0-465): a caller (CI) that omits `modelTag` entirely used to silently land on whatever
   * `BEX_RESPONSES_MODEL` resolves `preview` to (gpt-4.1-mini today), invalidating the 234-item
   * regression run on 2026-08-29 (7fb79091-e93b-4d52-a38b-4283f5cd639f, 64.6/D vs 71.3/C for the
   * same set on gpt-4.1). `preview` is still selectable when a caller passes it explicitly — this
   * only changes what an OMITTED field resolves to, matching the "Run dataset" form's own default
   * (B0-614, `TestRunModelControls`).
   */
  modelTag: z.enum(['preview', ...supportedModelNames]).default('gpt-4.1'),
  /**
   * B0-600 / B0-603 — enables the validator pass for a full-mode run so a validator A/B test can be
   * configured. Defaults false, matching every run created before this field existed.
   */
  useValidator: z.boolean().default(false),
  /**
   * B0-880 — opt-in forced specialist, mirroring the "Run dataset" form's agent-mode picker
   * (B0-351). Defaults to `orchestrator`, which `buildTestRunOptions` omits from the blob, so a
   * body without it persists exactly what it did before this field existed.
   */
  agentMode: z.enum(BEX_CHAT_AGENT_MODES).default(DEFAULT_BEX_CHAT_AGENT_MODE),
  /**
   * B0-880 — opt-in router override (B0-681). Deliberately NO default: an omitted field stays
   * `undefined`, `buildTestRunOptions` leaves `routerType` out of the blob, and the run falls back
   * to the settings-driven router — so a CI request that never sends it produces the same
   * `run_options` as today. Defaulting to `llm` would silently change every existing CI row.
   */
  routerType: z.enum(['keyword', 'semantic', 'llm']).optional(),
  useHybrid: z.boolean().default(false),
  useReranker: z.boolean().default(false),
  useMultiIntent: z.boolean().default(false),
});

export type CreateRunBody = z.infer<typeof createRunBodySchema>;
