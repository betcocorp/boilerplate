import type { WebSearchResult } from '~/lib/websearch/websearch-schemas';

/**
 * WEB-2 — Domain allowlist & source-trust policy.
 *
 * Classifies each external result into a trust tier and applies a configurable policy:
 * authoritative sources (manufacturer sites, EPA/gov, SDS repositories) rank first, low-trust
 * sources are down-ranked, and blocked domains are excluded. Config is env-driven so the policy
 * is not hard-coded per call site.
 */

export type TrustTier = 'authoritative' | 'standard' | 'low';

export type SourceTrustPolicy = {
  /** Suffix-matched domains treated as authoritative (ranked first). */
  authoritativeDomains: string[];
  /** Suffix-matched domains treated as low-trust (down-ranked). */
  lowTrustDomains: string[];
  /** Suffix-matched domains excluded entirely from results. */
  blockedDomains: string[];
};

/** Manufacturer, regulatory, and SDS sources that are authoritative for chemical facts. */
const DEFAULT_AUTHORITATIVE = [
  'gov',
  'epa.gov',
  'cdc.gov',
  'nih.gov',
  'osha.gov',
  'fda.gov',
  'betco.com',
  'spartanchemical.com',
  'diversey.com',
  'cloroxpro.com',
  'ecolab.com',
  'sdsmanager.com',
  'fishersci.com',
  'sigmaaldrich.com',
  'nfpa.org',
];

const DEFAULT_LOW_TRUST = [
  'reddit.com',
  'quora.com',
  'pinterest.com',
  'facebook.com',
  'x.com',
  'twitter.com',
  'tiktok.com',
  'medium.com',
];

const TIER_RANK: Record<TrustTier, number> = {
  authoritative: 3,
  standard: 2,
  low: 1,
};

function parseDomainList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
}

export function loadSourceTrustPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SourceTrustPolicy {
  return {
    authoritativeDomains: [
      ...DEFAULT_AUTHORITATIVE,
      ...parseDomainList(env.WEBSEARCH_TRUSTED_DOMAINS),
    ],
    lowTrustDomains: [
      ...DEFAULT_LOW_TRUST,
      ...parseDomainList(env.WEBSEARCH_LOW_TRUST_DOMAINS),
    ],
    blockedDomains: parseDomainList(env.WEBSEARCH_BLOCKED_DOMAINS),
  };
}

export function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** A domain matches a pattern when it equals it or is a subdomain of it. */
function domainMatches(domain: string, patterns: string[]): boolean {
  return patterns.some((p) => domain === p || domain.endsWith(`.${p}`));
}

export function classifySourceTrust(
  url: string,
  policy: SourceTrustPolicy,
): { tier: TrustTier; domain: string | null; blocked: boolean } {
  const domain = extractDomain(url);
  if (!domain) {
    return { tier: 'low', domain: null, blocked: false };
  }
  if (domainMatches(domain, policy.blockedDomains)) {
    return { tier: 'low', domain, blocked: true };
  }
  if (domainMatches(domain, policy.authoritativeDomains)) {
    return { tier: 'authoritative', domain, blocked: false };
  }
  if (domainMatches(domain, policy.lowTrustDomains)) {
    return { tier: 'low', domain, blocked: false };
  }
  return { tier: 'standard', domain, blocked: false };
}

/** Tag results with trust tier + domain, drop blocked sources, and sort by (trust, score). */
export function applySourceTrustPolicy(
  results: WebSearchResult[],
  policy: SourceTrustPolicy,
): { results: WebSearchResult[]; excludedCount: number } {
  const tagged: WebSearchResult[] = [];
  let excludedCount = 0;
  for (const result of results) {
    const classification = classifySourceTrust(result.url, policy);
    if (classification.blocked) {
      excludedCount += 1;
      continue;
    }
    tagged.push({
      ...result,
      trustTier: classification.tier,
      sourceDomain: classification.domain ?? undefined,
    });
  }
  tagged.sort((a, b) => {
    const tierDelta =
      TIER_RANK[b.trustTier ?? 'standard'] - TIER_RANK[a.trustTier ?? 'standard'];
    return tierDelta !== 0 ? tierDelta : b.score - a.score;
  });
  return { results: tagged, excludedCount };
}
