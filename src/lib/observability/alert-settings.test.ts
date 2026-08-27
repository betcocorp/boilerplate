import { beforeEach, describe, expect, it, vi } from 'vitest';

const from = vi.fn();
vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => ({ from }),
}));

import { DEFAULT_ALERT_THRESHOLDS } from '~/lib/observability/alert-rules';
import {
  ALERT_SETTING_KEYS,
  ALERT_WEBHOOK_URL_ENV,
  DEFAULT_ALERT_LOOKBACK_DAYS,
  getObservabilityAlertConfig,
} from '~/lib/observability/alert-settings';
import { resetSettingsCacheForTest } from '~/lib/settings/settings-service';

/** Per-key mock, mirroring `settings-service.test.ts`; absent keys behave as a missing row. */
function mockRows(values: Record<string, string>) {
  const select = vi.fn().mockReturnValue({
    eq: vi.fn((_column: string, key: string) => ({
      maybeSingle: vi.fn().mockResolvedValue({
        data: key in values ? { value: values[key] } : null,
        error: null,
      }),
    })),
  });
  from.mockReturnValue({ select });
}

beforeEach(() => {
  resetSettingsCacheForTest();
  from.mockReset();
  delete process.env[ALERT_WEBHOOK_URL_ENV];
});

describe('getObservabilityAlertConfig', () => {
  it('falls back to the seeded defaults when no rows exist', async () => {
    mockRows({});
    const config = await getObservabilityAlertConfig();
    expect(config.thresholds).toEqual(DEFAULT_ALERT_THRESHOLDS);
    expect(config.lookbackDays).toBe(DEFAULT_ALERT_LOOKBACK_DAYS);
    expect(config.sentryEnabled).toBe(true);
    expect(config.webhookUrl).toBeNull();
  });

  it('reads stored values from the settings table', async () => {
    mockRows({
      [ALERT_SETTING_KEYS.toolFailureRateWarning]: '0.05',
      [ALERT_SETTING_KEYS.toolFailureMinSettledCalls]: '25',
      [ALERT_SETTING_KEYS.goldenGateMissEnabled]: 'false',
      [ALERT_SETTING_KEYS.lookbackDays]: '14',
      [ALERT_SETTING_KEYS.sentryEnabled]: 'false',
    });

    const config = await getObservabilityAlertConfig();
    expect(config.thresholds.toolFailureRateWarning).toBe(0.05);
    expect(config.thresholds.toolFailureMinSettledCalls).toBe(25);
    expect(config.thresholds.goldenGateMissEnabled).toBe(false);
    expect(config.lookbackDays).toBe(14);
    expect(config.sentryEnabled).toBe(false);
  });

  it('rejects ONE bad stored value without discarding the others', async () => {
    mockRows({
      // A rate above 1 is meaningless and would make the rule unreachable.
      [ALERT_SETTING_KEYS.toolFailureRateWarning]: '15',
      [ALERT_SETTING_KEYS.toolFailureRateCritical]: '0.4',
    });

    const config = await getObservabilityAlertConfig();
    expect(config.thresholds.toolFailureRateWarning).toBe(
      DEFAULT_ALERT_THRESHOLDS.toolFailureRateWarning,
    );
    expect(config.thresholds.toolFailureRateCritical).toBe(0.4);
  });

  it('clamps the lookback window rather than scanning 10 years of audit rows', async () => {
    mockRows({ [ALERT_SETTING_KEYS.lookbackDays]: '4000' });
    expect((await getObservabilityAlertConfig()).lookbackDays).toBe(90);

    resetSettingsCacheForTest();
    mockRows({ [ALERT_SETTING_KEYS.lookbackDays]: '0' });
    expect((await getObservabilityAlertConfig()).lookbackDays).toBe(2);
  });

  it('accepts an http(s) webhook URL from the environment and nothing else', async () => {
    mockRows({});
    process.env[ALERT_WEBHOOK_URL_ENV] = 'https://hooks.example.com/abc';
    expect((await getObservabilityAlertConfig()).webhookUrl).toBe('https://hooks.example.com/abc');

    resetSettingsCacheForTest();
    process.env[ALERT_WEBHOOK_URL_ENV] = 'file:///etc/passwd';
    expect((await getObservabilityAlertConfig()).webhookUrl).toBeNull();

    resetSettingsCacheForTest();
    process.env[ALERT_WEBHOOK_URL_ENV] = 'not a url';
    expect((await getObservabilityAlertConfig()).webhookUrl).toBeNull();
  });
});
