import { resolveDeploymentProtectionBypass } from '~/lib/api/deployment-protection-bypass';
import { logWarn } from '~/lib/observability/logger';
import { resolveSelfOrigin } from '~/lib/tests/report/schedule-report-generation';

export type ScheduleRagEvaluationResult = {
  scheduled: boolean;
  reason?: string;
};

/** Starts deterministic scoring in a fresh route invocation when internal auth is configured. */
export async function scheduleRagEvaluation(
  testResultId: string,
): Promise<ScheduleRagEvaluationResult> {
  const token = process.env.CRON_SECRET;
  if (!token) return { scheduled: false, reason: 'no_token' };

  try {
    const origin = await resolveSelfOrigin();
    const bypass = resolveDeploymentProtectionBypass(origin);
    const response = await fetch(
      `${origin}/api/admin/tests/runs/${testResultId}/rag-evaluation`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...bypass.headers,
        },
        body: '{}',
      },
    );
    if (!response.ok) {
      logWarn('test_run_rag_evaluation_schedule_rejected', {
        testResultId,
        status: response.status,
      });
      return { scheduled: false, reason: `http_${response.status}` };
    }
    return { scheduled: true };
  } catch (error) {
    logWarn('test_run_rag_evaluation_schedule_error', {
      testResultId,
      message: error instanceof Error ? error.message : String(error),
    });
    return { scheduled: false, reason: 'fetch_failed' };
  }
}
