'use client';

/**
 * B0-463 — full persisted-prompt display for one of the three product-support LLM boundaries.
 *
 * DISPLAY ONLY: this renders exactly what `recordPrompt` in
 * `~/lib/workflows/product-support/run-product-support-workflow.ts` persisted to
 * `workflow_steps.input.prompt` (`{ stage, instructions, model, runtime }`). It never
 * reconstructs or re-derives prompt text — a run with no persisted `prompt` shows the
 * "not captured" state below rather than guessing.
 *
 * `promptVersion` / `promptBundleVersion` are run-level stamps (B0-393) read off
 * `workflow_run.final_output`, not per-step — the same pair is passed to every prompt-bearing
 * step in a run.
 */

import { TraceJsonBlock } from '~/components/admin/observability/TraceJsonBlock';
import { Badge } from '~/components/ui/badge';
import {
  promptStageSchema,
  type PromptRecord,
} from '~/lib/workflows/product-support/product-support-schemas';
import { shortHash } from '~/lib/workflows/product-support/prompt-version';

/**
 * The only step names the workflow ever captures a prompt at — mirrors `promptStageSchema`
 * exactly, so this list can never drift from what `recordPrompt` is allowed to stamp `stage`
 * with. Any other step name (`orchestration_planner`, `early_decline_gate`) never carries a
 * `prompt` record, so this block does not render for it at all — not even a "not captured" row.
 */
const PROMPT_CAPTURE_STEP_NAMES: ReadonlySet<string> = new Set(promptStageSchema.options);

const STAGE_LABELS: Record<PromptRecord['stage'], string> = {
  openai_responses_agent: 'Main agent',
  validator: 'Validator',
  revision: 'Revision',
};

export function isPromptCaptureStep(stepName: string): boolean {
  return PROMPT_CAPTURE_STEP_NAMES.has(stepName);
}

export function StepPromptDetail({
  stepName,
  prompt,
  promptVersion,
  promptBundleVersion,
}: {
  stepName: string;
  prompt: PromptRecord | null;
  /** Run-level `promptVersion` (specialist prompt hash), or null if this run predates B0-393. */
  promptVersion: string | null;
  /** Run-level `promptBundleVersion` (every prompt constant + tool definition), or null. */
  promptBundleVersion: string | null;
}) {
  if (!isPromptCaptureStep(stepName)) {
    return null;
  }

  if (!prompt) {
    return (
      <div className="min-w-0 space-y-1">
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Prompt
        </p>
        <p className="text-xs text-slate-500">
          Not captured for this step — this run predates prompt capture (B0-389), or this pass
          was bypassed rather than actually calling a model.
        </p>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-2 rounded-xl border border-sky-100 bg-sky-50/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="rounded-full border-sky-300 bg-sky-100 text-sky-900" variant="outline">
          {STAGE_LABELS[prompt.stage] ?? prompt.stage}
        </Badge>
        <Badge className="rounded-full font-mono text-[0.65rem]" variant="outline">
          model {prompt.model}
        </Badge>
        <Badge className="rounded-full font-mono text-[0.65rem]" variant="outline">
          runtime {prompt.runtime}
        </Badge>
        {promptVersion ? (
          <Badge
            className="rounded-full font-mono text-[0.65rem]"
            title={`promptVersion (specialist prompt): ${promptVersion}`}
            variant="outline"
          >
            prompt {shortHash(promptVersion)}
          </Badge>
        ) : null}
        {promptBundleVersion ? (
          <Badge
            className="rounded-full font-mono text-[0.65rem]"
            title={`promptBundleVersion (prompt + tool bundle): ${promptBundleVersion}`}
            variant="outline"
          >
            bundle {shortHash(promptBundleVersion)}
          </Badge>
        ) : null}
      </div>
      <TraceJsonBlock label="Full prompt (instructions sent to the model)" value={prompt.instructions} />
    </div>
  );
}
