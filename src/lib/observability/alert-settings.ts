/**
 * B0-466 — resolves the alert evaluator's tunables from the `settings` table.
 *
 * Lives here rather than in `~/lib/settings/settings-service.ts` so that module keeps its narrow
 * set of shared getters and does not gain a dependency on the observability domain; it reuses
 * `getNumberSetting` / `getBooleanSetting` / `getStringSetting`, which already fall back rather
 * than throw when a row is missing or the DB is unreachable (a settings outage must not stop the
 * alerter from running with its defaults).
 *
 * Keys are seeded by `20260827021000_add_observability_alert_settings_b0466.sql` and editable at
 * /admin/settings. Every resolved value is re-validated through `alertThresholdsSchema` here,
 * because `settings.value` is free text with no per-row constraint — a hand-edited `-1` or `abc`
 * must degrade to the default, never reach a rule.
 *
 * The optional outbound webhook URL is read from the environment, NOT from `settings`: a webhook
 * URL is a credential, and `settings` is a table an admin UI can display and edit.
 */

import {
  alertThresholdsSchema,
  DEFAULT_ALERT_THRESHOLDS,
  type AlertThresholds,
} from '~/lib/observability/alert-rules';
import { logWarn } from '~/lib/observability/logger';
import {
  getBooleanSetting,
  getNumberSetting,
} from '~/lib/settings/settings-service';

/** `settings` keys this module reads, so the set is greppable from one place. */
export const ALERT_SETTING_KEYS = {
  sentryEnabled: 'ALERT_SENTRY_ENABLED',
  lookbackDays: 'ALERT_TOOL_FAILURE_LOOKBACK_DAYS',
  toolFailureRateWarning: 'ALERT_TOOL_FAILURE_RATE_WARNING',
  toolFailureRateCritical: 'ALERT_TOOL_FAILURE_RATE_CRITICAL',
  toolFailureMinSettledCalls: 'ALERT_TOOL_FAILURE_MIN_SETTLED_CALLS',
  toolFailureSpikeDelta: 'ALERT_TOOL_FAILURE_SPIKE_DELTA',
  toolFailureSpikeRatio: 'ALERT_TOOL_FAILURE_SPIKE_RATIO',
  goldenPassRateDropWarning: 'ALERT_GOLDEN_PASS_RATE_DROP_WARNING',
  goldenPassRateDropCritical: 'ALERT_GOLDEN_PASS_RATE_DROP_CRITICAL',
  goldenMinGradedItems: 'ALERT_GOLDEN_MIN_GRADED_ITEMS',
  goldenGateMissEnabled: 'ALERT_GOLDEN_GATE_MISS_ENABLED',
} as const;

/** Env var holding the optional generic outbound webhook. Unset = no webhook, not an error. */
export const ALERT_WEBHOOK_URL_ENV = 'OBSERVABILITY_ALERT_WEBHOOK_URL';

/** Default lookback for the tool-failure series. 7 days gives the spike rule a baseline to find. */
export const DEFAULT_ALERT_LOOKBACK_DAYS = 7;
const MIN_LOOKBACK_DAYS = 2;
const MAX_LOOKBACK_DAYS = 90;

export type ObservabilityAlertConfig = {
  thresholds: AlertThresholds;
  /** Days of tool-call history the evaluator scans, clamped to 2..90. */
  lookbackDays: number;
  sentryEnabled: boolean;
  /** `null` when the env var is unset or not an http(s) URL — the route still runs. */
  webhookUrl: string | null;
};

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readWebhookUrl(): string | null {
  const raw = process.env[ALERT_WEBHOOK_URL_ENV]?.trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = new URL(raw);
    // Anything other than http(s) (file:, data:) is a misconfiguration, not a delivery channel.
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? raw : null;
  } catch {
    logWarn('observability_alert_webhook_url_invalid', { env: ALERT_WEBHOOK_URL_ENV });
    return null;
  }
}

export async function getObservabilityAlertConfig(): Promise<ObservabilityAlertConfig> {
  const defaults = DEFAULT_ALERT_THRESHOLDS;

  const [
    sentryEnabled,
    lookbackDays,
    toolFailureRateWarning,
    toolFailureRateCritical,
    toolFailureMinSettledCalls,
    toolFailureSpikeDelta,
    toolFailureSpikeRatio,
    goldenPassRateDropWarning,
    goldenPassRateDropCritical,
    goldenMinGradedItems,
    goldenGateMissEnabled,
  ] = await Promise.all([
    getBooleanSetting(ALERT_SETTING_KEYS.sentryEnabled, true),
    getNumberSetting(ALERT_SETTING_KEYS.lookbackDays, DEFAULT_ALERT_LOOKBACK_DAYS),
    getNumberSetting(ALERT_SETTING_KEYS.toolFailureRateWarning, defaults.toolFailureRateWarning),
    getNumberSetting(ALERT_SETTING_KEYS.toolFailureRateCritical, defaults.toolFailureRateCritical),
    getNumberSetting(
      ALERT_SETTING_KEYS.toolFailureMinSettledCalls,
      defaults.toolFailureMinSettledCalls,
    ),
    getNumberSetting(ALERT_SETTING_KEYS.toolFailureSpikeDelta, defaults.toolFailureSpikeDelta),
    getNumberSetting(ALERT_SETTING_KEYS.toolFailureSpikeRatio, defaults.toolFailureSpikeRatio),
    getNumberSetting(
      ALERT_SETTING_KEYS.goldenPassRateDropWarning,
      defaults.goldenPassRateDropWarning,
    ),
    getNumberSetting(
      ALERT_SETTING_KEYS.goldenPassRateDropCritical,
      defaults.goldenPassRateDropCritical,
    ),
    getNumberSetting(ALERT_SETTING_KEYS.goldenMinGradedItems, defaults.goldenMinGradedItems),
    getBooleanSetting(ALERT_SETTING_KEYS.goldenGateMissEnabled, defaults.goldenGateMissEnabled),
  ]);

  // Per-field fallback: one out-of-range stored value must not discard the other ten. `safeParse`
  // on the whole object would reject all of them together, so each field is validated alone.
  const candidate: Record<keyof AlertThresholds, unknown> = {
    toolFailureRateWarning,
    toolFailureRateCritical,
    toolFailureMinSettledCalls,
    toolFailureSpikeDelta,
    toolFailureSpikeRatio,
    goldenPassRateDropWarning,
    goldenPassRateDropCritical,
    goldenMinGradedItems,
    goldenGateMissEnabled,
  };

  const resolved: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(candidate)) {
    const fieldSchema = alertThresholdsSchema.shape[field as keyof AlertThresholds];
    const parsed = fieldSchema.safeParse(value);
    if (parsed.success) {
      resolved[field] = parsed.data;
    } else {
      logWarn('observability_alert_threshold_invalid', { field, value });
      resolved[field] = defaults[field as keyof AlertThresholds];
    }
  }

  return {
    thresholds: alertThresholdsSchema.parse(resolved),
    lookbackDays: clampInt(
      lookbackDays,
      MIN_LOOKBACK_DAYS,
      MAX_LOOKBACK_DAYS,
      DEFAULT_ALERT_LOOKBACK_DAYS,
    ),
    sentryEnabled,
    webhookUrl: readWebhookUrl(),
  };
}
