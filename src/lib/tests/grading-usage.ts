import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import type { ModelProvider } from '~/lib/constants/models';
import { logWarn } from '~/lib/observability/logger';
import type { LlmTokenUsage } from '~/lib/openai/responses-runtime';

/**
 * B0-1109 — the three per-item graders that run during test execution (criteria, decline,
 * failure-root-cause). B0-1112 widened this to also cover report-generation grading call sites:
 * case_scorer (per-item, but multiple passes — see `passIndex` below), synthesizer_digest,
 * synthesizer_final, run_insights, and run_comparison_analysis (whole-run/whole-comparison, no
 * single test item).
 */
export type GradingCallSite =
  | 'criteria_grader'
  | 'decline_grader'
  | 'failure_root_cause'
  | 'case_scorer'
  | 'synthesizer_digest'
  | 'synthesizer_final'
  | 'run_insights'
  | 'run_comparison_analysis';

export type GradingUsageContext = {
  testResultId: string;
  /** Omit for call sites with no single test item (run_insights, run_comparison_analysis, synthesizer_*). */
  testItemId?: string;
  /** B0-1112 — disambiguates case_scorer's multiple grading passes per testItemId. */
  passIndex?: number;
};

/**
 * B0-1109 — persists the token usage of one grading model call so a run's grading cost is exact
 * (`public.test_grading_cost_by_run`). Fire-and-forget by design: grading must never fail or slow
 * down because a usage row couldn't be written, so callers do not await this, and any write failure
 * is only logged, never thrown.
 */
export function recordGradingUsage(params: {
  context: GradingUsageContext;
  callSite: GradingCallSite;
  provider: ModelProvider;
  model: string;
  usage: LlmTokenUsage;
}): void {
  const supabase = getSupabaseServiceRoleClient();
  void supabase
    .from('test_grading_usage')
    .insert({
      test_result_id: params.context.testResultId,
      test_item_id: params.context.testItemId ?? null,
      pass_index: params.context.passIndex ?? null,
      call_site: params.callSite,
      provider: params.provider,
      model: params.model,
      prompt_tokens: params.usage.promptTokens,
      completion_tokens: params.usage.completionTokens,
      cached_prompt_tokens: params.usage.cachedPromptTokens,
      total_tokens: params.usage.totalTokens,
    })
    .then(({ error }) => {
      if (error) {
        logWarn('test_grading_usage_persist_failed', {
          testResultId: params.context.testResultId,
          testItemId: params.context.testItemId,
          callSite: params.callSite,
          message: error.message,
        });
      }
    });
}
