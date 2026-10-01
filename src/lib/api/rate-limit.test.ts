import { describe, expect, it } from 'vitest';

import { evaluateRateLimit, RATE_LIMIT_WINDOW_SECONDS } from '~/lib/api/rate-limit';

describe('evaluateRateLimit (B0-119)', () => {
  it('never limits when the cap is null or non-positive (unlimited)', () => {
    expect(evaluateRateLimit({ limitPerMinute: null, recentCount: 999 }).limited).toBe(false);
    expect(evaluateRateLimit({ limitPerMinute: 0, recentCount: 999 }).limited).toBe(false);
  });

  it('allows requests below the cap', () => {
    expect(evaluateRateLimit({ limitPerMinute: 5, recentCount: 4 })).toEqual({
      limited: false,
      retryAfterSeconds: 0,
    });
  });

  it('limits at and above the cap, with a Retry-After of the window size', () => {
    expect(evaluateRateLimit({ limitPerMinute: 5, recentCount: 5 })).toEqual({
      limited: true,
      retryAfterSeconds: RATE_LIMIT_WINDOW_SECONDS,
    });
    expect(evaluateRateLimit({ limitPerMinute: 5, recentCount: 6 }).limited).toBe(true);
  });
});
