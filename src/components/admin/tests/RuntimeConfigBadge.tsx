import { Badge } from '~/components/ui/badge';
import { BEX_CHAT_AGENT_MODE_LABELS } from '~/lib/agents/agent-registry';
import {
  GENERATION_RUNTIME_SHORT_LABELS,
  generationRuntimeLabel,
  type GenerationRuntime,
} from '~/lib/llm/generation-runtime';
import type { TestRunConfig } from '~/lib/tests/run-config';
import type { RuntimeConfig } from '~/lib/workflows/product-support/product-support-schemas';

/**
 * B0-351 — the run's OWN config: what `test_results.run_options` asked for, written when the run
 * row was created and never changed afterwards. Distinct from the `RuntimeConfig` below, which is
 * what the workflow observed while executing.
 *
 * Rendered both on the run detail page (via `RuntimeConfigBadge`) and in the "Run config" column of
 * the runs list, so two runs of the same dataset that differ only in validator, agent mode, model,
 * or router are told apart without opening either one.
 */
export function RunConfigBadges({
  runConfig,
  /** Off in the runs list, where `RunModelLabel` already resolves the tag to a real model id. */
  showModel = true,
}: {
  runConfig: TestRunConfig | null;
  showModel?: boolean;
}) {
  if (!runConfig) {
    return null;
  }

  return (
    <>
      {showModel ? (
        <Badge
          title={
            runConfig.modelTag
              ? `run_options.modelTag: ${runConfig.modelTag}`
              : 'No model tag recorded for this run (it predates the option).'
          }
          variant="outline"
        >
          model {runConfig.modelTag ?? '—'}
        </Badge>
      ) : null}
      <Badge
        title={`run_options.useValidator: ${runConfig.useValidator}`}
        variant="outline"
      >
        validator {runConfig.useValidator ? 'on' : 'off'}
      </Badge>
      <Badge
        title={
          runConfig.agentMode === 'orchestrator'
            ? 'run_options.agentMode: orchestrator — specialist auto-selected per item by intent.'
            : `run_options.agentMode: ${runConfig.agentMode} — every item forced onto this specialist.`
        }
        variant="outline"
      >
        agent {BEX_CHAT_AGENT_MODE_LABELS[runConfig.agentMode]}
      </Badge>
      {runConfig.routerType ? (
        <Badge title={`run_options.routerType: ${runConfig.routerType}`} variant="outline">
          router {runConfig.routerType}
        </Badge>
      ) : null}
    </>
  );
}

/**
 * B0-494 — run-level chip for the resolved runtime-switch snapshot, same family as the B0-398
 * `PromptBundleVersionBadge`. Renders nothing for a historical run that predates this ticket (AC:
 * never a misleading placeholder implying "fully enabled").
 *
 * The B0-452 kill switch (`confidenceGatingDisabled`) gets its own distinctly-styled badge: a run
 * executed under it must be identifiable at a glance, since any recorded confidence cap on that
 * run is fiction (the gate detected something but the kill switch stopped it from acting).
 *
 * B0-351 — when a `runConfig` is supplied, its chips render first and the two OBSERVED chips that
 * would restate them (`validator`, `forced <agentMode>`) are suppressed: the harness threads
 * `run_options.useValidator`/`agentMode` straight into `runBexChatTurn`, so for a harness run the
 * observed values are the requested values by construction, and showing both reads as a bug.
 */
export function RuntimeConfigBadge({
  runtimeConfig,
  runConfig = null,
  generationRuntime = null,
}: {
  runtimeConfig: RuntimeConfig | null;
  runConfig?: TestRunConfig | null;
  /**
   * B0-912 — the RUN-level generation loop, from `test_results.summary.generationRuntime` (written
   * once by `executeTestRun`). When supplied it replaces the per-item `aiSdkGenerationEnabled`
   * chip below: both report the same fact, and the run-level value covers the whole run rather than
   * whichever item's payload the page happened to sample. Null for runs predating the field, which
   * fall back to that per-item chip.
   */
  generationRuntime?: GenerationRuntime | null;
}) {
  if (!runtimeConfig && !runConfig && !generationRuntime) {
    return null;
  }

  return (
    <>
      <RunConfigBadges runConfig={runConfig} />
      {generationRuntime ? (
        <Badge
          title={`summary.generationRuntime: ${generationRuntime} — ${generationRuntimeLabel(generationRuntime)}. Which loop served the run (B0-912); an Anthropic model can only be served by the AI SDK loop, an OpenAI model follows BEX_AI_SDK_GENERATION_ENABLED.`}
          variant="outline"
        >
          {GENERATION_RUNTIME_SHORT_LABELS[generationRuntime]} runtime
        </Badge>
      ) : null}
      {runtimeConfig ? (
        <>
          {runtimeConfig.confidenceGatingDisabled ? (
            <Badge
              title="BEX_DISABLE_CONFIDENCE_GATING was true for this run: confidence caps and rejections were detected but not enforced."
              variant="destructive"
            >
              confidence gating disabled
            </Badge>
          ) : null}
          {/* B0-756 — split kill switch; defaults to bypassed until the REC-4/XREF scorer is fixed, so this is expected to show on most runs, not an anomaly. */}
          {runtimeConfig.recommendationConfidenceGatingDisabled ? (
            <Badge
              title="BEX_DISABLE_RECOMMENDATION_CONFIDENCE_GATING was true for this run: the REC-4 similarity/brand/category-mismatch caps and the XREF recommendation gate were detected but not enforced (defaults to bypassed pending a scorer fix — see B0-756)."
              variant="outline"
            >
              recommendation confidence gating disabled
            </Badge>
          ) : null}
          {runConfig ? null : (
            <Badge
              title={`useValidator: ${runtimeConfig.useValidator}`}
              variant="outline"
            >
              validator {runtimeConfig.useValidator ? 'on' : 'off'}
            </Badge>
          )}
          <Badge
            title={`earlyDeclineGateEnabled: ${runtimeConfig.earlyDeclineGateEnabled}`}
            variant="outline"
          >
            decline gate {runtimeConfig.earlyDeclineGateEnabled ? 'on' : 'off'}
          </Badge>
          {/* B0-912 — suppressed when the run-level `generationRuntime` chip above already says
              this; showing both would read as a bug (same rule the runConfig/observed pairs use). */}
          {generationRuntime ? null : (
            <Badge
              title={`aiSdkGenerationEnabled: ${runtimeConfig.aiSdkGenerationEnabled}`}
              variant="outline"
            >
              {runtimeConfig.aiSdkGenerationEnabled ? 'ai-sdk' : 'responses'} runtime
            </Badge>
          )}
          <Badge title={`rerankerActive: ${runtimeConfig.rerankerActive}`} variant="outline">
            reranker {runtimeConfig.rerankerActive ? 'on' : 'off'}
          </Badge>
          {runtimeConfig.routedDirectly && !runConfig ? (
            <Badge title={`agentMode: ${runtimeConfig.agentMode}`} variant="outline">
              forced {runtimeConfig.agentMode}
            </Badge>
          ) : null}
        </>
      ) : null}
    </>
  );
}
