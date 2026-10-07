/**
 * B0-466 — production wiring for observability alerting: resolve config → fetch series →
 * evaluate (pure) → deliver → persist. The route handler
 * (`/api/v1/observability/evaluate-alerts`) stays thin by calling this, exactly as
 * `/api/v1/observability/sweep-stalled-runs` calls `runStalledRunSweep`.
 *
 * ## Delivery channels, and why these
 * 1. **Structured log** — always, via `logWarn`/`logInfo`. Zero configuration, visible in Vercel
 *    logs, and the one channel that cannot be misconfigured.
 * 2. **Sentry `captureMessage`** — one message per finding (so Sentry groups by metric), tagged
 *    `alert: observability` / `metric` / `severity`, `level: error` for critical and `warning`
 *    otherwise. Needs no new dependency and no new secret; the Sentry SDK is already wired
 *    (`src/instrumentation.ts`). Precedent: `maybeSendLabelSyncAlert` in
 *    `app/(authenticated)/admin/labels/pipeline.ts` (B0-259). NOTE this repo does not manage Sentry
 *    alert ROUTING — someone must add a Sentry alert rule on `observability_alert:*` for these to
 *    reach a human inbox. Until then Sentry is a durable record, not a page.
 * 3. **Optional generic webhook** — `OBSERVABILITY_ALERT_WEBHOOK_URL`, POST JSON, 5s timeout,
 *    strictly optional. Unset is the normal case and is not an error. No SendGrid, no Slack SDK.
 *
 * Delivery is best-effort by construction: every channel is individually try/caught and its
 * outcome recorded on the persisted row. A channel failure never changes the verdict and never
 * fails the route — an alerter that 500s because a webhook was down would be worse than useless.
 */

import { z } from 'zod';

import {
  recordAlertEvaluation,
  type AlertEvaluationTrigger,
  type AlertEvaluationVerdict,
} from '~/lib/observability/alert-evaluation-repository';
import {
  alertThresholdsSchema,
  evaluateAlertRules,
  maxSeverity,
  type AlertEvaluation,
  type AlertFinding,
  type AlertSeverity,
  type AlertThresholds,
} from '~/lib/observability/alert-rules';
import { getObservabilityAlertConfig } from '~/lib/observability/alert-settings';
import { logInfo, logWarn } from '~/lib/observability/logger';
import { getToolFailureRateSeries } from '~/lib/observability/tool-failure-series';
import { getGoldenRunSeries } from '~/lib/tests/golden-set-run-series';
import { getTierTargets } from '~/lib/tests/tier-targets';
import type { Json } from '~/types/supabase.public';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * Request body for a manual evaluation.
 *
 * `thresholds` is a PARTIAL override merged over the values resolved from `settings`, and it is
 * how an operator forces an alert on demand for QA (e.g. `{"toolFailureRateWarning": 0,
 * "toolFailureMinSettledCalls": 1}`) without editing a setting everyone else reads. Overridden
 * runs are still persisted, with `thresholdSource` recorded, so a forced alert is never mistaken
 * for a real one afterwards.
 */
export const evaluateAlertsInputSchema = z.object({
  lookbackDays: z.number().int().min(1).max(90).optional(),
  bucketSize: z.enum(['day', 'hour']).optional(),
  /** Evaluate and persist, but skip Sentry and the webhook. */
  dryRun: z.boolean().default(false),
  thresholds: alertThresholdsSchema.partial().optional(),
});
export type EvaluateAlertsInput = z.input<typeof evaluateAlertsInputSchema>;

export type AlertDeliveryOutcome = {
  logged: true;
  sentry: 'sent' | 'disabled' | 'skipped_dry_run' | 'failed' | 'no_findings';
  webhook: 'sent' | 'not_configured' | 'skipped_dry_run' | 'failed' | 'no_findings';
  webhookStatus?: number;
  error?: string;
};

export type RunAlertEvaluationResult = {
  evaluatedAt: string;
  trigger: AlertEvaluationTrigger;
  verdict: AlertEvaluationVerdict;
  maxSeverity: AlertSeverity | null;
  findings: AlertFinding[];
  metrics: AlertEvaluation['metrics'];
  thresholds: AlertThresholds;
  thresholdSource: 'settings' | 'settings+override';
  window: { from: string; to: string };
  delivery: AlertDeliveryOutcome;
  durationMs: number;
  /** `null` when the evaluation row could not be written — reported, never silently dropped. */
  evaluationId: string | null;
};

async function emitToSentry(
  findings: readonly AlertFinding[],
): Promise<'sent' | 'failed'> {
  try {
    const Sentry = await import('@sentry/nextjs');
    for (const finding of findings) {
      Sentry.captureMessage(`observability_alert:${finding.metric}`, {
        level: finding.severity === 'critical' ? 'error' : 'warning',
        tags: {
          alert: 'observability',
          metric: finding.metric,
          severity: finding.severity,
        },
        extra: {
          message: finding.message,
          window: finding.window,
          observed: finding.observed,
          threshold: finding.threshold,
          sampleSize: finding.sampleSize,
          ...finding.context,
        },
      });
    }
    return 'sent';
  } catch (error) {
    logWarn('observability_alert_sentry_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}

async function emitToWebhook(
  url: string,
  body: unknown,
): Promise<{ result: 'sent' | 'failed'; status?: number }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!response.ok) {
      logWarn('observability_alert_webhook_rejected', { status: response.status });
      return { result: 'failed', status: response.status };
    }
    return { result: 'sent', status: response.status };
  } catch (error) {
    logWarn('observability_alert_webhook_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { result: 'failed' };
  }
}

/**
 * Runs one full evaluation. Never throws for a delivery or persistence problem; a genuine data
 * failure (Supabase unreachable mid-scan) does propagate, and the route turns it into a persisted
 * `verdict = 'error'` row plus a 500.
 */
export async function runAlertEvaluation(
  input: EvaluateAlertsInput = {},
  trigger: AlertEvaluationTrigger = 'cron',
): Promise<RunAlertEvaluationResult> {
  const startedAtMs = Date.now();
  const options = evaluateAlertsInputSchema.parse(input);
  const config = await getObservabilityAlertConfig();

  const lookbackDays = options.lookbackDays ?? config.lookbackDays;
  const bucketSize = options.bucketSize ?? 'day';
  const to = new Date(startedAtMs).toISOString();
  const from = new Date(startedAtMs - lookbackDays * DAY_MS).toISOString();
  const window = { from, to };

  const hasOverride = Boolean(options.thresholds && Object.keys(options.thresholds).length > 0);
  const thresholds = alertThresholdsSchema.parse({
    ...config.thresholds,
    ...(options.thresholds ?? {}),
  });

  const [toolSeries, goldenTrend, tierTargets] = await Promise.all([
    getToolFailureRateSeries(window, bucketSize),
    // The golden trend is deliberately NOT window-filtered: golden runs are operator-triggered and
    // can be weeks apart, so restricting them to the tool-failure lookback would routinely leave
    // no previous run to compare against.
    getGoldenRunSeries(),
    getTierTargets(),
  ]);

  const evaluation = evaluateAlertRules({ toolSeries, goldenTrend, tierTargets, thresholds });
  const severity = maxSeverity(evaluation.findings);
  const verdict: AlertEvaluationVerdict = evaluation.findings.length > 0 ? 'findings' : 'ok';

  const delivery: AlertDeliveryOutcome = {
    logged: true,
    sentry: 'no_findings',
    webhook: 'no_findings',
  };

  if (evaluation.findings.length > 0) {
    for (const finding of evaluation.findings) {
      logWarn('observability_alert_finding', {
        metric: finding.metric,
        severity: finding.severity,
        window: finding.window,
        observed: finding.observed,
        threshold: finding.threshold,
        sample_size: finding.sampleSize,
        message: finding.message,
      });
    }

    if (options.dryRun) {
      delivery.sentry = 'skipped_dry_run';
      delivery.webhook = 'skipped_dry_run';
    } else {
      delivery.sentry = config.sentryEnabled
        ? await emitToSentry(evaluation.findings)
        : 'disabled';

      if (config.webhookUrl) {
        const outcome = await emitToWebhook(config.webhookUrl, {
          source: 'bex-2.0',
          evaluatedAt: to,
          trigger,
          severity,
          findings: evaluation.findings,
        });
        delivery.webhook = outcome.result;
        if (outcome.status !== undefined) {
          delivery.webhookStatus = outcome.status;
        }
      } else {
        delivery.webhook = 'not_configured';
      }
    }
  } else {
    logInfo('observability_alert_evaluation_ok', {
      window_from: from,
      window_to: to,
      bucket_size: bucketSize,
      current_bucket: evaluation.metrics.toolFailure.current?.bucket ?? null,
      current_failure_rate: evaluation.metrics.toolFailure.current?.failureRate ?? null,
      current_settled: evaluation.metrics.toolFailure.current?.settled ?? 0,
      tool_skipped: evaluation.metrics.toolFailure.skipped,
      golden_tests_compared: evaluation.metrics.goldenSet.testsCompared,
    });
  }

  const durationMs = Date.now() - startedAtMs;
  const evaluationId = await recordAlertEvaluation({
    evaluatedAt: to,
    trigger,
    verdict,
    findingCount: evaluation.findings.length,
    maxSeverity: severity,
    findings: evaluation.findings as unknown as Json,
    thresholds: {
      ...thresholds,
      thresholdSource: hasOverride ? 'settings+override' : 'settings',
      lookbackDays,
      bucketSize,
      dryRun: options.dryRun,
    } as unknown as Json,
    metrics: evaluation.metrics as unknown as Json,
    delivery: delivery as unknown as Json,
    windowFrom: from,
    windowTo: to,
    durationMs,
    error: null,
  });

  return {
    evaluatedAt: to,
    trigger,
    verdict,
    maxSeverity: severity,
    findings: evaluation.findings,
    metrics: evaluation.metrics,
    thresholds,
    thresholdSource: hasOverride ? 'settings+override' : 'settings',
    window,
    delivery,
    durationMs,
    evaluationId,
  };
}

/**
 * Records a failed evaluation so the trail shows the attempt rather than a gap. Called by the route
 * when `runAlertEvaluation` throws; a gap in `observability_alert_evaluations` would otherwise look
 * exactly like the cron never firing.
 */
export async function recordAlertEvaluationFailure(params: {
  error: unknown;
  trigger: AlertEvaluationTrigger;
  startedAtMs: number;
}): Promise<void> {
  const message =
    params.error instanceof Error ? params.error.message : String(params.error);
  logWarn('observability_alert_evaluation_failed', { error: message });
  await recordAlertEvaluation({
    evaluatedAt: new Date().toISOString(),
    trigger: params.trigger,
    verdict: 'error',
    findingCount: 0,
    maxSeverity: null,
    findings: [] as unknown as Json,
    thresholds: {} as unknown as Json,
    metrics: {} as unknown as Json,
    delivery: { logged: true } as unknown as Json,
    windowFrom: null,
    windowTo: null,
    durationMs: Date.now() - params.startedAtMs,
    error: message,
  });
}
