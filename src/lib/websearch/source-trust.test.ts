import { describe, expect, it } from 'vitest';

import {
  applySourceTrustPolicy,
  classifySourceTrust,
  loadSourceTrustPolicyFromEnv,
  type SourceTrustPolicy,
} from '~/lib/websearch/source-trust';
import type { WebSearchResult } from '~/lib/websearch/websearch-schemas';

const policy: SourceTrustPolicy = {
  authoritativeDomains: ['epa.gov', 'betco.com'],
  lowTrustDomains: ['reddit.com'],
  blockedDomains: ['spam.example'],
};

function result(url: string, score: number): WebSearchResult {
  return { title: url, url, snippet: '', score };
}

describe('classifySourceTrust', () => {
  it('tiers by domain (incl. subdomains) and flags blocked domains', () => {
    expect(classifySourceTrust('https://www.epa.gov/x', policy).tier).toBe('authoritative');
    expect(classifySourceTrust('https://sds.betco.com/y', policy).tier).toBe('authoritative');
    expect(classifySourceTrust('https://reddit.com/r/z', policy).tier).toBe('low');
    expect(classifySourceTrust('https://acme.example/p', policy).tier).toBe('standard');
    const blocked = classifySourceTrust('https://spam.example/p', policy);
    expect(blocked.blocked).toBe(true);
  });
});

describe('applySourceTrustPolicy', () => {
  it('excludes blocked, ranks authoritative first, then by score, and tags tier + domain', () => {
    const { results, excludedCount } = applySourceTrustPolicy(
      [
        result('https://acme.example/a', 0.9), // standard, high score
        result('https://spam.example/b', 0.99), // blocked → excluded
        result('https://epa.gov/c', 0.5), // authoritative, low score
        result('https://reddit.com/d', 0.8), // low
      ],
      policy,
    );
    expect(excludedCount).toBe(1);
    expect(results.map((r) => r.url)).toEqual([
      'https://epa.gov/c', // authoritative first despite lowest score
      'https://acme.example/a', // standard
      'https://reddit.com/d', // low last
    ]);
    expect(results[0]).toMatchObject({ trustTier: 'authoritative', sourceDomain: 'epa.gov' });
  });
});

describe('loadSourceTrustPolicyFromEnv', () => {
  it('merges env domain lists into the defaults', () => {
    const p = loadSourceTrustPolicyFromEnv({
      WEBSEARCH_TRUSTED_DOMAINS: 'mycorp.com, extra.io',
      WEBSEARCH_BLOCKED_DOMAINS: 'bad.test',
    } as NodeJS.ProcessEnv);
    expect(p.authoritativeDomains).toContain('epa.gov'); // default kept
    expect(p.authoritativeDomains).toContain('mycorp.com'); // env added
    expect(p.blockedDomains).toContain('bad.test');
  });
});
