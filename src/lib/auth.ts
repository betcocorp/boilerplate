import * as Sentry from "@sentry/nextjs";
import { type NextAuthOptions } from "next-auth";
import AzureADProvider from "next-auth/providers/azure-ad";

import { setAuthUserDetails } from "~/lib/actions/cookies";
import { AUTH_SESSION_MAX_AGE_SECONDS } from "~/lib/cookies-config";
import { logError, logInfo, logWarn } from "~/lib/observability/logger";
import {
  isPermissionsEnforced,
  recordPermissionVerdict,
  type PermissionVerdictReason,
} from "~/lib/permissions/enforcement";
import { setCachedPermissions } from "~/lib/permissions/redis";
import { getPermissionsForUser, getUser } from "~/lib/permissions/repository";
import type User from "~/types/User";

/**
 * Sign-in outcome for an Azure-AD-authenticated identity that failed the bex `app_user` gate.
 * The value is the `?error=` code the sign-in page renders (see `src/app/page.tsx`).
 */
type SignInRejection =
  | "/?error=NoIdentity"
  | "/?error=UserNotFound"
  | "/?error=AccountInactive"
  | "/?error=AccessDenied";

/**
 * Records the rejection and applies `BEX_PERMISSIONS_ENFORCED` (B0-408): while the flag is off the
 * user signs in anyway with a warning, which is today's behaviour for every Azure-AD identity. The
 * `app_user` seed only covers 130 CRM users, so shadow mode is what keeps real bex users working.
 */
async function gateSignIn(params: {
  rejection: SignInRejection;
  reason: PermissionVerdictReason;
  message: string;
  email?: string | null;
  userId?: string | null;
  provider?: string | null;
  error?: unknown;
}): Promise<true | SignInRejection> {
  const { rejection, reason, message, email, userId, provider, error } = params;
  const enforced = isPermissionsEnforced();

  const fields = {
    reason,
    message,
    email: email ?? null,
    provider: provider ?? null,
    enforced,
    outcome: enforced ? "rejected" : "shadow-allowed",
  };

  if (error) {
    logError("auth.login.failure", { ...fields, error: String(error) });
    Sentry.captureException(error, { extra: fields });
  } else {
    logWarn("auth.login.failure", fields);
    Sentry.captureMessage(`bex sign-in rejected: ${reason}`, {
      level: enforced ? "warning" : "info",
      extra: fields,
    });
  }

  await recordPermissionVerdict({
    surface: "auth",
    selector: "auth.signin",
    allowed: false,
    reason,
    route: "callbacks.signIn",
    userId,
    email,
    detail: { rejection },
  });

  return enforced ? rejection : true;
}

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
      checks: ["pkce", "state"],
      authorization: {
        params: {
          scope: "openid profile email",
          prompt: "select_account",
        },
      },
    }),
  ],
  secret: process.env.NEXTAUTH_SECRET,
  pages: {
    signIn: "/",
  },
  callbacks: {
    /**
     * bex-side gate: the identity provider says who you are, `public.app_user` says whether you
     * belong here. Enforced only when `BEX_PERMISSIONS_ENFORCED=true`.
     */
    async signIn({ user, account, profile }) {
      const provider = account?.provider ?? null;

      if (!user?.email) {
        return gateSignIn({
          rejection: "/?error=NoIdentity",
          reason: "no-identity",
          message: "No email from identity provider",
          email: profile?.email ?? null,
          provider,
        });
      }

      try {
        const result = await getUser(user.email.trim());
        if (!result.success || result.rowcount < 1 || !result.data[0]) {
          return gateSignIn({
            rejection: "/?error=UserNotFound",
            reason: "user-not-found",
            message: "No app_user row for this email",
            email: user.email,
            provider,
          });
        }

        const appUser = result.data[0];
        if (appUser.IS_ACTIVE === false) {
          return gateSignIn({
            rejection: "/?error=AccountInactive",
            reason: "account-inactive",
            message: "app_user row is inactive",
            email: user.email,
            userId: appUser.USER_ID,
            provider,
          });
        }

        return true;
      } catch (error) {
        return gateSignIn({
          rejection: "/?error=AccessDenied",
          reason: "lookup-failed",
          message: "Error loading app_user during sign-in",
          email: user.email,
          provider,
          error,
        });
      }
    },
    async jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token;
      }
      return token;
    },
    async session({ session, token }) {
      if (token.accessToken) {
        (session as { accessToken?: string }).accessToken =
          token.accessToken as string;
      }
      return session;
    },
    async redirect({ url, baseUrl }) {
      if (url.startsWith("/")) {
        return `${baseUrl}${url}`;
      }
      if (new URL(url).origin === baseUrl) {
        return url;
      }
      return `${baseUrl}/admin`;
    },
  },
  events: {
    /**
     * Prefetch the permission bundle into Redis and stamp the auth-user cookie (with `GROUPS`) so
     * the first authenticated render already has permissions. Runs in both modes — shadow mode
     * still needs the cookie, otherwise `getUserOrDefault()` is empty and every surface looks
     * denied. Failures are logged, never thrown: a broken prefetch must not block sign-in, and
     * `/api/auth/rebuild-user` repairs the cookie on the next request.
     */
    async signIn({ user }) {
      const email = user?.email?.trim();
      if (!email) return;

      try {
        const result = await getUser(email);
        const appUser = result.success ? result.data[0] : undefined;
        if (!appUser?.USER_ID) {
          logWarn("auth.login.prefetch_skipped", {
            email,
            reason: "no-app_user-row",
          });
          return;
        }

        const { permissions, permission_groups } = await getPermissionsForUser(
          appUser.USER_ID,
        );
        await setCachedPermissions(
          appUser.USER_ID,
          permissions,
          permission_groups,
        );
        await setAuthUserDetails({
          ...(appUser as User),
          GROUPS: permission_groups,
        });

        logInfo("auth.login.success", {
          email,
          userId: appUser.USER_ID,
          groups: permission_groups,
          permissionCount: permissions.length,
        });
      } catch (error) {
        logError("auth.login.prefetch_failed", {
          email,
          error: String(error),
        });
        Sentry.captureException(error, { extra: { email } });
      }
    },
  },
};
