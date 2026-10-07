import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEPLOYMENT_PROTECTION_BYPASS_MISSING_HINT,
  DEPLOYMENT_PROTECTION_BYPASS_REJECTED_HINT,
  describeDeploymentProtectionFailure,
  resolveDeploymentProtectionBypass,
  VERCEL_PROTECTION_BYPASS_HEADER,
} from './deployment-protection-bypass';

const DEPLOYED = 'https://bex.example.vercel.app';
const LOCAL = 'http://localhost:3000';

describe('resolveDeploymentProtectionBypass (B0-966)', () => {
  const original = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  beforeEach(() => {
    delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    } else {
      process.env.VERCEL_AUTOMATION_BYPASS_SECRET = original;
    }
  });

  it('attaches the bypass header when the secret is present', () => {
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = 'abc123';
    const bypass = resolveDeploymentProtectionBypass(DEPLOYED);

    expect(bypass.state).toBe('attached');
    expect(bypass.headers).toEqual({ [VERCEL_PROTECTION_BYPASS_HEADER]: 'abc123' });
  });

  it('reports `missing` for a deployed origin with no secret, and sends no header', () => {
    const bypass = resolveDeploymentProtectionBypass(DEPLOYED);

    expect(bypass.state).toBe('missing');
    expect(bypass.headers).toEqual({});
  });

  it('treats a localhost origin with no secret as the healthy local case', () => {
    // Local development is never behind Deployment Protection, so a missing secret there must not
    // be reported as a problem — otherwise every dev run grows a spurious warning.
    for (const origin of [LOCAL, 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      const bypass = resolveDeploymentProtectionBypass(origin);
      expect(bypass.state, origin).toBe('not_required_local');
      expect(bypass.headers, origin).toEqual({});
    }
  });

  it('still attaches the header on localhost when a secret IS set', () => {
    // `vercel env pull` puts the secret in .env.local; sending it locally is harmless and keeps
    // local behaviour identical to deployed.
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = 'abc123';
    expect(resolveDeploymentProtectionBypass(LOCAL).state).toBe('attached');
  });

  it('ignores a whitespace-only secret rather than sending a blank header', () => {
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = '   ';
    const bypass = resolveDeploymentProtectionBypass(DEPLOYED);

    expect(bypass.state).toBe('missing');
    expect(bypass.headers).toEqual({});
  });

  it('trims a secret that picked up surrounding whitespace', () => {
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = '  abc123\n';
    expect(resolveDeploymentProtectionBypass(DEPLOYED).headers).toEqual({
      [VERCEL_PROTECTION_BYPASS_HEADER]: 'abc123',
    });
  });

  it('treats an unparseable origin as deployed, so a missing secret is reported not excused', () => {
    expect(resolveDeploymentProtectionBypass('not a url').state).toBe('missing');
  });

  it('never puts the secret in the hint text', () => {
    expect(DEPLOYMENT_PROTECTION_BYPASS_MISSING_HINT).not.toMatch(/abc123/);
    expect(DEPLOYMENT_PROTECTION_BYPASS_MISSING_HINT).toContain(
      'VERCEL_AUTOMATION_BYPASS_SECRET',
    );
  });

  it('uses the header name Vercel documents, lowercase', () => {
    expect(VERCEL_PROTECTION_BYPASS_HEADER).toBe('x-vercel-protection-bypass');
  });
});

describe('describeDeploymentProtectionFailure (B0-966)', () => {
  it('explains a 401 with no secret as the missing case', () => {
    expect(describeDeploymentProtectionFailure(401, { state: 'missing' })).toContain(
      DEPLOYMENT_PROTECTION_BYPASS_MISSING_HINT,
    );
  });

  it('explains a 401 despite a sent secret as the stale/rejected case', () => {
    // The distinction B0-966 exists to make: before this, "never generated" and "rotated without a
    // redeploy" were the same opaque 401.
    expect(describeDeploymentProtectionFailure(401, { state: 'attached' })).toContain(
      DEPLOYMENT_PROTECTION_BYPASS_REJECTED_HINT,
    );
  });

  it('says nothing for a 401 from localhost — that is the app’s own auth, not the edge', () => {
    expect(describeDeploymentProtectionFailure(401, { state: 'not_required_local' })).toBe('');
  });

  it('says nothing for any status other than 401', () => {
    // Stapling a protection hint onto a 500 or a timeout sends the reader somewhere irrelevant.
    for (const status of [400, 403, 404, 409, 500, 502, 504]) {
      expect(describeDeploymentProtectionFailure(status, { state: 'missing' }), String(status)).toBe(
        '',
      );
    }
  });

  it('returns a leading-space-prefixed string so callers can append unconditionally', () => {
    const hint = describeDeploymentProtectionFailure(401, { state: 'missing' });
    expect(hint.startsWith(' ')).toBe(true);
    expect(`HTTP 401${hint}`).toMatch(/^HTTP 401 VERCEL_AUTOMATION_BYPASS_SECRET/);
  });
});
