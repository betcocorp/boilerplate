import { type NextAuthOptions } from 'next-auth';
import AzureADProvider from 'next-auth/providers/azure-ad';

import { AUTH_SESSION_MAX_AGE_SECONDS } from '~/lib/cookies-config';

/**
 * NextAuth config example: Azure AD (Entra ID) as the identity provider, JWT sessions. Swap in
 * whatever provider(s) your app needs (see next-auth.js.org/providers), and add an
 * `signIn`/`session` callback here if you need to gate access against your own user/permission
 * tables — this scaffold intentionally does no app-side authorization, only authentication.
 */
export const authOptions: NextAuthOptions = {
  session: {
    maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
  },
  jwt: {
    maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
  },
  providers: [
    AzureADProvider({
      clientId: process.env.AZURE_AD_CLIENT_ID!,
      clientSecret: process.env.AZURE_AD_CLIENT_SECRET!,
      tenantId: process.env.AZURE_AD_TENANT_ID,
      checks: ['pkce', 'state'],
      authorization: {
        params: {
          scope: 'openid profile email',
          prompt: 'select_account',
        },
      },
    }),
  ],
  secret: process.env.NEXTAUTH_SECRET,
  pages: {
    signIn: '/',
  },
  callbacks: {
    async redirect({ url, baseUrl }) {
      if (url.startsWith('/')) {
        return `${baseUrl}${url}`;
      }
      if (new URL(url).origin === baseUrl) {
        return url;
      }
      return baseUrl;
    },
  },
};
