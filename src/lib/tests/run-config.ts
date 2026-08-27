import { z } from 'zod';

import { BEX_CHAT_AGENT_MODES, DEFAULT_BEX_CHAT_AGENT_MODE } from '~/lib/agents/agent-registry';
import type { RouterTypeOverride } from '~/lib/workflows/product-support/run-product-support-workflow';

/**
 * B0-351 — the per-run execution config stored in `test_results.run_options` (a jsonb column that
 * already exists; no migration was needed to add `agentMode`).
 *
 * This is the ONE reader of that blob: `run-executor.ts` uses it to decide how the run executes and
 * the admin pages / CSV export use it to show what a run was executed with, so the display can never
 * disagree with the execution. The blob is written once by `runTestAction` when the run row is
 * created and never updated afterwards — that is what makes a run's config immutable.
 *
 * Every field is tolerant of absence because historical rows predate each option (53 runs have a
 * literally empty `{}`): a missing value means "whatever the default was when that run executed",
 * which for `agentMode` is `orchestrator` (it was hardcoded before this ticket) and for
 * `useValidator` is `false`. `modelTag` is the exception — it stays `null` rather than defaulting to
 * `preview`, because reporting a model a run never recorded would invent a fact (B0-632).
 *
 * `run_mode: 'search'` runs store a different blob (`useHybrid`/`useReranker`/`useMultiIntent`) and
 * have their own page; parsing one of those here yields the all-defaults config, which is correct —
 * a search eval runs no chat model, validator, or agent mode at all.
 */

const ROUTER_TYPE_OVERRIDES = ['keyword', 'semantic', 'llm'] as const;

export const testRunConfigSchema = z.object({
  /** `run_options.modelTag`; `null` for a run that recorded no tag. */
  modelTag: z
    .unknown()
    .transform((value) => (typeof value === 'string' && value.trim() ? value.trim() : null)),
  /** `run_options.useValidator`; anything other than literal `true` is off, as before this ticket. */
  useValidator: z.unknown().transform((value) => value === true),
  /** `run_options.agentMode`; unrecognised or absent → `orchestrator` (the pre-B0-351 hardcoded value). */
  agentMode: z
    .unknown()
    .transform((value) =>
      typeof value === 'string' && (BEX_CHAT_AGENT_MODES as readonly string[]).includes(value)
        ? (value as (typeof BEX_CHAT_AGENT_MODES)[number])
        : DEFAULT_BEX_CHAT_AGENT_MODE,
    ),
  /** `run_options.routerType`; `null` leaves the settings-driven router in charge (B0-681). */
  routerType: z
    .unknown()
    .transform((value) =>
      typeof value === 'string' && (ROUTER_TYPE_OVERRIDES as readonly string[]).includes(value)
        ? (value as RouterTypeOverride)
        : null,
    ),
});

export type TestRunConfig = z.infer<typeof testRunConfigSchema>;

/** Parses `test_results.run_options` (typed `Json`, so genuinely `unknown`) into a run config. */
export function parseTestRunConfig(runOptions: unknown): TestRunConfig {
  const source =
    runOptions && typeof runOptions === 'object' && !Array.isArray(runOptions)
      ? (runOptions as Record<string, unknown>)
      : {};

  // Every field is a total transform, so this cannot fail — `parse` is correct here.
  return testRunConfigSchema.parse({
    modelTag: source.modelTag,
    useValidator: source.useValidator,
    agentMode: source.agentMode,
    routerType: source.routerType,
  });
}

/**
 * The `run_options` blob to persist for a new chat run. Keys whose value is the pre-existing default
 * are OMITTED rather than written, so a run created today is byte-comparable with the runs created
 * before each option existed (and `agentMode: 'orchestrator'` doesn't start appearing on rows whose
 * behaviour never changed).
 */
export function buildTestRunOptions(config: {
  modelTag: string;
  useValidator: boolean;
  agentMode: TestRunConfig['agentMode'];
  routerType?: RouterTypeOverride;
}): Record<string, string | boolean> {
  return {
    modelTag: config.modelTag,
    useValidator: config.useValidator,
    ...(config.agentMode !== DEFAULT_BEX_CHAT_AGENT_MODE ? { agentMode: config.agentMode } : {}),
    ...(config.routerType ? { routerType: config.routerType } : {}),
  };
}
