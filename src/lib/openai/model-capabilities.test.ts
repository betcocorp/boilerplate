import { beforeEach, describe, expect, it } from 'vitest';

import {
  __resetLearnedSamplingSupport,
  isTemperatureUnsupportedError,
  recordTemperatureRejection,
  samplingParamsFor,
  supportsSamplingControls,
} from '~/lib/openai/model-capabilities';

/**
 * B0-606 — the model/parameter matrix here is not invented: every case was checked against the
 * live Responses API on 2026-08-20. The accept cases matter as much as the reject cases, because
 * the obvious `/^gpt-5/` implementation would break gpt-5.1/5.2/5.4, which DO accept temperature.
 */

beforeEach(() => {
  __resetLearnedSamplingSupport();
});

describe('supportsSamplingControls (B0-606)', () => {
  it('rejects the models verified to reject temperature', () => {
    for (const model of [
      'gpt-5',
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-5-2025-08-07',
      'gpt-5.5',
      'gpt-5.5-2026-04-23',
      'gpt-5.5-pro',
      'gpt-5.6',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'o3-mini',
      'o1',
      'o4-mini',
    ]) {
      expect(supportsSamplingControls(model), model).toBe(false);
    }
  });

  it('rejects every Anthropic id, since Opus 5 / Sonnet 5 400 on any sampling control (B0-908)', () => {
    for (const model of [
      'claude-haiku-4-5',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-sonnet-5-20260101',
      ' Claude-Opus-5 ',
    ]) {
      expect(supportsSamplingControls(model), model).toBe(false);
      expect(samplingParamsFor(model, { temperature: 0 })).toEqual({});
    }
  });

  it('still allows the gpt-5.x versions that DO accept temperature', () => {
    // The whole reason this is a denylist and not a version regex.
    for (const model of [
      'gpt-5.1',
      'gpt-5.2',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-2026-03-05',
    ]) {
      expect(supportsSamplingControls(model), model).toBe(true);
    }
  });

  it('allows the gpt-4 family and unknown models', () => {
    for (const model of ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'some-future-model']) {
      expect(supportsSamplingControls(model), model).toBe(true);
    }
  });

  it('is case- and whitespace-insensitive', () => {
    expect(supportsSamplingControls('  GPT-5.6  ')).toBe(false);
    expect(supportsSamplingControls('GPT-4.1')).toBe(true);
  });
});

describe('samplingParamsFor (B0-606)', () => {
  it('omits the key entirely for a rejecting model', () => {
    const params = samplingParamsFor('gpt-5.6', { temperature: 0.2 });
    // Absent, not present-and-undefined: the API rejects on presence, not on value.
    expect(params).toEqual({});
    expect('temperature' in params).toBe(false);
  });

  it('passes the value through unchanged for an accepting model', () => {
    expect(samplingParamsFor('gpt-4.1', { temperature: 0.2 })).toEqual({ temperature: 0.2 });
    // Determinism on the validator path must survive: 0 is a value, not "unset".
    expect(samplingParamsFor('gpt-4.1', { temperature: 0 })).toEqual({ temperature: 0 });
  });

  it('omits the key when no temperature was requested', () => {
    expect(samplingParamsFor('gpt-4.1', {})).toEqual({});
  });
});

describe('isTemperatureUnsupportedError (B0-606)', () => {
  it('matches the real API message', () => {
    expect(
      isTemperatureUnsupportedError(
        new Error("400 Unsupported parameter: 'temperature' is not supported with this model."),
      ),
    ).toBe(true);
    // Same check against a plain object and a bare string, since SDK error shapes vary.
    expect(
      isTemperatureUnsupportedError({
        message: "Unsupported parameter: 'temperature' is not supported with this model.",
      }),
    ).toBe(true);
    expect(
      isTemperatureUnsupportedError("Unsupported parameter: 'temperature' is not supported"),
    ).toBe(true);
  });

  it('does not match unrelated failures, so they are not silently swallowed', () => {
    expect(isTemperatureUnsupportedError(new Error('fetch failed'))).toBe(false);
    expect(isTemperatureUnsupportedError(new Error('429 rate limit exceeded'))).toBe(false);
    // A different unsupported parameter must not be mistaken for the temperature case.
    expect(
      isTemperatureUnsupportedError(new Error("Unsupported parameter: 'top_p' is not supported")),
    ).toBe(false);
    expect(isTemperatureUnsupportedError(null)).toBe(false);
    expect(isTemperatureUnsupportedError(undefined)).toBe(false);
  });
});

describe('recordTemperatureRejection (B0-606)', () => {
  it('learns an unknown model and stops sending temperature to it', () => {
    expect(supportsSamplingControls('mystery-model')).toBe(true);

    expect(recordTemperatureRejection('mystery-model')).toBe(true);

    expect(supportsSamplingControls('mystery-model')).toBe(false);
    expect(samplingParamsFor('mystery-model', { temperature: 0.2 })).toEqual({});
  });

  it('returns false the second time, which is what bounds the caller to one replay', () => {
    expect(recordTemperatureRejection('mystery-model')).toBe(true);
    expect(recordTemperatureRejection('mystery-model')).toBe(false);
  });

  it('returns false for a model already on the static denylist — no pointless replay', () => {
    expect(recordTemperatureRejection('gpt-5.6')).toBe(false);
  });

  it('does not leak the learned model across a reset', () => {
    recordTemperatureRejection('mystery-model');
    __resetLearnedSamplingSupport();
    expect(supportsSamplingControls('mystery-model')).toBe(true);
  });

  it('learns per-model, not globally', () => {
    recordTemperatureRejection('mystery-model');
    expect(supportsSamplingControls('gpt-4.1')).toBe(true);
  });
});
