import { describe, expect, it } from 'vitest';

import { UpstreamTransportError } from '~/lib/openai/transport-retry';

import {
  classifyProviderFault,
  isProviderFaultKind,
  PROVIDER_FAULT_ABORT_STREAK,
  PROVIDER_FAULT_KINDS,
  PROVIDER_FAULT_LABEL,
  providerFaultKindSchema,
} from './provider-fault';

/** The exact string every eval item threw after the 2026-09-14 ~19:25 UTC credit exhaustion. */
const INCIDENT_MESSAGE =
  'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.';

/** An error with an HTTP status, the shape the OpenAI SDK throws. */
function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

describe('classifyProviderFault — B0-1014', () => {
  it('classifies the verbatim 2026-09-14 credit-exhaustion message as insufficient_quota', () => {
    expect(classifyProviderFault(new Error(INCIDENT_MESSAGE))).toBe('insufficient_quota');
  });

  describe('wording fallback (bare Error, no HTTP status)', () => {
    it.each([
      ['no credits remaining', INCIDENT_MESSAGE],
      ['insufficient_quota code', 'Error code: insufficient_quota'],
      ['exceeded your current quota', 'You exceeded your current quota, please check your plan.'],
      ['billing + credits', 'Your billing account has no credits left.'],
    ])('reads %s as insufficient_quota', (_label, message) => {
      expect(classifyProviderFault(new Error(message))).toBe('insufficient_quota');
    });

    it.each([
      ['invalid api key', 'Invalid API key provided: sk-***.'],
      ['incorrect api key', 'Incorrect API key provided.'],
      ['authentication failed', 'Authentication failed for this request.'],
      ['unauthorized', 'Unauthorized'],
    ])('reads %s as invalid_credentials', (_label, message) => {
      expect(classifyProviderFault(new Error(message))).toBe('invalid_credentials');
    });

    it('reads rate-limit wording as rate_limited', () => {
      expect(classifyProviderFault(new Error('Rate limit reached for gpt-4.1.'))).toBe(
        'rate_limited',
      );
    });

    it.each([
      ['overloaded', 'The model is overloaded. Please try again later.'],
      ['service unavailable', 'Service Unavailable'],
      ['bad gateway', 'Bad Gateway'],
    ])('reads %s as provider_unavailable', (_label, message) => {
      expect(classifyProviderFault(new Error(message))).toBe('provider_unavailable');
    });

    it('is case-insensitive', () => {
      expect(classifyProviderFault(new Error('YOU HAVE NO CREDITS REMAINING.'))).toBe(
        'insufficient_quota',
      );
    });
  });

  describe('the live outage shape (probed 2026-09-15)', () => {
    /**
     * Verbatim: OpenAI answers 429 with
     * `{"error":{"message":…,"type":"insufficient_quota","param":null,"code":"credit_balance_exhausted"}}`
     * and the SDK hangs the parsed body plus `status` off the thrown error.
     */
    function liveQuotaError(): Error {
      return Object.assign(new Error(`429 ${INCIDENT_MESSAGE}`), {
        status: 429,
        error: {
          message: INCIDENT_MESSAGE,
          type: 'insufficient_quota',
          param: null,
          code: 'credit_balance_exhausted',
        },
      });
    }

    it('classifies the live 429 + insufficient_quota body as insufficient_quota', () => {
      expect(classifyProviderFault(liveQuotaError())).toBe('insufficient_quota');
    });

    it('classifies on the structural code even when the prose is rewritten', () => {
      const error = Object.assign(new Error('Something went wrong.'), {
        code: 'credit_balance_exhausted',
      });
      expect(classifyProviderFault(error)).toBe('insufficient_quota');
    });

    it('classifies on a nested `error.type` reached through `cause`', () => {
      const error = new Error('Upstream call failed', {
        cause: { error: { type: 'insufficient_quota' } },
      });
      expect(classifyProviderFault(error)).toBe('insufficient_quota');
    });

    it('does not confuse a throughput 429 with the billing one', () => {
      const error = Object.assign(new Error('429 Rate limit reached for gpt-4.1'), {
        status: 429,
        error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' },
      });
      expect(classifyProviderFault(error)).toBe('rate_limited');
    });
  });

  describe('HTTP status wins over wording', () => {
    it('maps 401 to invalid_credentials even when the body mentions a rate limit', () => {
      expect(classifyProviderFault(httpError(401, 'rate limit'))).toBe('invalid_credentials');
    });

    it('maps 403 to invalid_credentials', () => {
      expect(classifyProviderFault(httpError(403, 'Forbidden'))).toBe('invalid_credentials');
    });

    it('maps a quota-flavoured 429 to insufficient_quota', () => {
      expect(
        classifyProviderFault(httpError(429, 'You exceeded your current quota, check your billing')),
      ).toBe('insufficient_quota');
    });

    it('maps a plain 429 to rate_limited', () => {
      expect(classifyProviderFault(httpError(429, 'Too many requests'))).toBe('rate_limited');
    });

    it.each([500, 502, 503, 529])('maps %i to provider_unavailable', (status) => {
      expect(classifyProviderFault(httpError(status, 'Server error'))).toBe('provider_unavailable');
    });

    it('reads the AI SDK `statusCode` shape as well as the OpenAI `status` one', () => {
      const error = Object.assign(new Error('Unauthorized'), { statusCode: 401 });
      expect(classifyProviderFault(error)).toBe('invalid_credentials');
    });
  });

  describe('UpstreamTransportError', () => {
    it('classifies from rawMessage, not the user-facing message the wrapper substitutes', () => {
      const wrapped = new UpstreamTransportError({
        rawMessage: INCIDENT_MESSAGE,
        attempts: 3,
        runtime: 'responses',
        reason: 'http_429',
        statusCode: 429,
        cause: new Error(INCIDENT_MESSAGE),
      });

      // Sanity: the wrapper really does hide the provider text behind retry-able copy.
      expect(wrapped.message).not.toContain('no credits remaining');
      expect(classifyProviderFault(wrapped)).toBe('insufficient_quota');
    });

    it('classifies a wrapped 5xx as provider_unavailable', () => {
      const wrapped = new UpstreamTransportError({
        rawMessage: '500 Internal Server Error',
        attempts: 3,
        runtime: 'ai_sdk',
        reason: 'http_5xx',
        statusCode: 500,
        cause: new Error('500 Internal Server Error'),
      });

      expect(classifyProviderFault(wrapped)).toBe('provider_unavailable');
    });

    it('returns null for a wrapped network fault with no provider verdict', () => {
      const wrapped = new UpstreamTransportError({
        rawMessage: 'TypeError: fetch failed',
        attempts: 3,
        runtime: 'responses',
        reason: 'network',
        cause: new TypeError('fetch failed'),
      });

      expect(classifyProviderFault(wrapped)).toBeNull();
    });
  });

  describe('quality failures must never be read as an outage', () => {
    it.each([
      ['a graded concept miss', 'Missed 1 tier-1 (must-have) criterion: "states the dilution".'],
      ['a decline', "I don't have the verified information on the required wet contact time."],
      ['an empty response', 'The assistant returned an empty response.'],
      ['a Zod failure', 'Invalid input: expected string, received undefined at "prompt"'],
      ['a tool error', 'get_efficacy_data failed: no rows matched product_line_key BETCO-1234.'],
      ['a validation 400', 'Invalid value for parameter `temperature`.'],
      ['an unknown failure', 'Unknown test item run failure.'],
      ['a transport timeout', 'Request timed out.'],
    ])('classifies %s as null', (_label, message) => {
      expect(classifyProviderFault(new Error(message))).toBeNull();
    });

    it('classifies a 400 validation error as null', () => {
      expect(classifyProviderFault(httpError(400, 'Invalid schema for tool get_products.'))).toBeNull();
    });

    it('classifies non-Error values as null', () => {
      expect(classifyProviderFault(null)).toBeNull();
      expect(classifyProviderFault(undefined)).toBeNull();
      expect(classifyProviderFault('something went wrong')).toBeNull();
    });
  });
});

describe('provider-fault contract', () => {
  it('exposes a label for every kind', () => {
    for (const kind of PROVIDER_FAULT_KINDS) {
      expect(PROVIDER_FAULT_LABEL[kind]).toBeTruthy();
    }
  });

  it('accepts only the four kinds', () => {
    expect(providerFaultKindSchema.safeParse('insufficient_quota').success).toBe(true);
    expect(providerFaultKindSchema.safeParse('nonsense').success).toBe(false);
    expect(isProviderFaultKind('rate_limited')).toBe(true);
    expect(isProviderFaultKind('nonsense')).toBe(false);
  });

  it('aborts after five consecutive faults', () => {
    expect(PROVIDER_FAULT_ABORT_STREAK).toBe(5);
  });
});
