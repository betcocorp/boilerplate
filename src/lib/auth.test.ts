import { describe, expect, it } from 'vitest';

import { authOptions } from '~/lib/auth';

describe('authOptions', () => {
  it('configures exactly one Azure AD provider', () => {
    expect(authOptions.providers).toHaveLength(1);
  });

  it('redirects relative paths and same-origin urls through, and falls back to baseUrl otherwise', async () => {
    const redirect = authOptions.callbacks!.redirect!;
    const baseUrl = 'https://example.com';

    await expect(redirect({ url: '/dashboard', baseUrl })).resolves.toBe(
      `${baseUrl}/dashboard`,
    );
    await expect(
      redirect({ url: `${baseUrl}/dashboard`, baseUrl }),
    ).resolves.toBe(`${baseUrl}/dashboard`);
    await expect(
      redirect({ url: 'https://evil.example/dashboard', baseUrl }),
    ).resolves.toBe(baseUrl);
  });
});
