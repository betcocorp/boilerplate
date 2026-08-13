import { describe, expect, it, vi } from 'vitest';

import {
  classifyTransportError,
  computeJitteredDelayMs,
  isUpstreamTransportError,
  retryTransportFaults,
  toUserFacingErrorMessage,
  UPSTREAM_RETRY_USER_MESSAGE,
  UpstreamTransportError,
} from '~/lib/openai/transport-retry';

/** Mirrors an OpenAI SDK `APIError`: status + message, no `code`. */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

/** Mirrors undici: `TypeError: fetch failed` wrapping the real socket error as `cause`. */
function fetchFailed(code = 'ECONNRESET'): Error {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

const tuning = { sleep: async () => undefined, random: () => 0.5 };

describe('classifyTransportError (B0-370)', () => {
  it('treats the four observed production faults as retryable', () => {
    // The exact error texts from the 11 failed steps in the ticket.
    expect(classifyTransportError(fetchFailed()).retryable).toBe(true);
    expect(classifyTransportError(httpError(500, 'Internal server error')).reason).toBe('http_5xx');
    expect(classifyTransportError(new Error('Connection error.')).retryable).toBe(true);
    expect(classifyTransportError(new Error('Request timed out.')).reason).toBe('timeout');
  });

  it('retries 429 and 5xx but never other 4xx', () => {
    expect(classifyTransportError(httpError(429, 'Rate limit reached')).retryable).toBe(true);
    expect(classifyTransportError(httpError(503, 'Service unavailable')).retryable).toBe(true);
    expect(classifyTransportError(httpError(408, 'Request Timeout')).retryable).toBe(true);

    for (const status of [400, 401, 403, 404, 409, 413, 422]) {
      expect(classifyTransportError(httpError(status, 'Invalid schema')).retryable).toBe(false);
    }
  });

  it('refuses a 4xx even when its body mentions a timeout (status beats message sniffing)', () => {
    // Guards the ordering in the classifier: a validation error must never be replayed just
    // because its wording overlaps with a transport fault.
    const validation = httpError(400, 'Invalid value for "timeout": expected number');
    expect(classifyTransportError(validation).retryable).toBe(false);
  });

  it('unwraps the cause chain and honours the AI SDK isRetryable flag', () => {
    expect(classifyTransportError(fetchFailed('UND_ERR_CONNECT_TIMEOUT')).reason).toBe('timeout');
    const apiCallError = Object.assign(new Error('Cannot connect to API: fetch failed'), {
      isRetryable: true,
    });
    expect(classifyTransportError(apiCallError).retryable).toBe(true);
  });

  it('retries an abort caused by a timeout but not a caller-initiated abort', () => {
    const timeoutAbort = Object.assign(new Error('The operation timed out.'), { name: 'AbortError' });
    expect(classifyTransportError(timeoutAbort).retryable).toBe(true);

    const userAbort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    expect(classifyTransportError(userAbort).retryable).toBe(false);
  });

  it('does not retry an ordinary programming error', () => {
    expect(classifyTransportError(new TypeError('x is not a function')).retryable).toBe(false);
  });
});

describe('retryTransportFaults (B0-370)', () => {
  it('retries a network fault and returns the eventual success', async () => {
    const fn = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(fetchFailed())
      .mockResolvedValueOnce('ok');

    const result = await retryTransportFaults(fn, {
      runtime: 'responses',
      label: 'test',
      ...tuning,
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('propagates a 4xx unchanged on the first failure, without retrying', async () => {
    const original = httpError(400, 'Invalid schema');
    const fn = vi.fn<(attempt: number) => Promise<string>>().mockRejectedValue(original);

    // The raw error is rethrown as-is so a genuine defect keeps its message and stack.
    await expect(
      retryTransportFaults(fn, { runtime: 'responses', label: 'test', ...tuning }),
    ).rejects.toBe(original);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('wraps an exhausted transport fault in a user-facing UpstreamTransportError', async () => {
    const fn = vi.fn<(attempt: number) => Promise<string>>().mockRejectedValue(fetchFailed());

    const error = await retryTransportFaults(fn, {
      runtime: 'responses',
      label: 'test',
      attempts: 3,
      ...tuning,
    }).catch((err: unknown) => err);

    expect(fn).toHaveBeenCalledTimes(3);
    expect(isUpstreamTransportError(error)).toBe(true);
    const upstream = error as UpstreamTransportError;
    expect(upstream.message).toBe(UPSTREAM_RETRY_USER_MESSAGE);
    // The raw provider text is preserved for debugging even though the message is now friendly.
    expect(upstream.rawMessage).toBe('fetch failed');
    expect(upstream.attempts).toBe(3);
    expect(upstream.runtime).toBe('responses');
  });

  it('honours the canRetry veto and still reports the friendly message', async () => {
    const fn = vi.fn<(attempt: number) => Promise<string>>().mockRejectedValue(fetchFailed());

    const error = await retryTransportFaults(fn, {
      runtime: 'responses',
      label: 'test',
      canRetry: () => false,
      ...tuning,
    }).catch((err: unknown) => err);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(isUpstreamTransportError(error)).toBe(true);
  });

  it('caps attempts and backs off with jitter between them', async () => {
    const delays: number[] = [];
    const fn = vi.fn<(attempt: number) => Promise<string>>().mockRejectedValue(fetchFailed());

    await retryTransportFaults(fn, {
      runtime: 'ai_sdk',
      label: 'test',
      attempts: 3,
      baseDelayMs: 200,
      random: () => 1,
      sleep: async (ms) => {
        delays.push(ms);
      },
    }).catch(() => undefined);

    // Two waits for three attempts, growing exponentially (equal-jitter upper bound here).
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([200, 400]);
  });

  it('produces a jittered delay inside the equal-jitter band and respects the ceiling', () => {
    const args = { baseDelayMs: 250, maxDelayMs: 2_000 };
    expect(computeJitteredDelayMs({ ...args, attempt: 1, random: () => 0 })).toBe(125);
    expect(computeJitteredDelayMs({ ...args, attempt: 1, random: () => 1 })).toBe(250);
    // Ceiling clamps the exponential growth so backoff cannot blow the request latency budget.
    expect(computeJitteredDelayMs({ ...args, attempt: 12, random: () => 1 })).toBe(2_000);
  });
});

describe('toUserFacingErrorMessage (B0-370)', () => {
  it('rewrites an exhausted transport fault but leaves other errors legible', () => {
    const upstream = new UpstreamTransportError({
      rawMessage: 'fetch failed',
      attempts: 3,
      runtime: 'responses',
      reason: 'network',
      cause: fetchFailed(),
    });

    expect(toUserFacingErrorMessage(upstream)).toBe(UPSTREAM_RETRY_USER_MESSAGE);
    expect(toUserFacingErrorMessage(new Error('validator rejected the answer'))).toBe(
      'validator rejected the answer',
    );
  });
});
