import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import type { ModelProvider } from '~/lib/constants/models';
import { logWarn } from '~/lib/observability/logger';
import type { LlmTokenUsage } from '~/lib/openai/responses-runtime';

/**
 * B0-1109 — the three per-item graders that run during test execution (criteria, decline,
 * failure-root-cause). Deliberately does NOT cover report-generation grading (case-scorer,
 * synthesizer, run-insights, run-comparison-analysis) — that is a separate, later scope.
 */
export type GradingCallSite = 'criteria_grader' | 'decline_grader' | 'failure_root_cause';

export type GradingUsageContext = {
  testResultId: string;
  testItemId: string;
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
      test_item_id: params.context.testItemId,
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
