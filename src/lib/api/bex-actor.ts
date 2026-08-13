import { authenticateApiToken } from '~/lib/api/client-auth';
import { hasBexSession } from '~/lib/api/bex-api-auth';
import { getUserOrDefault } from '~/lib/cookies-server';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { hasPermission } from '~/lib/permissions/permissions-server';
import { getPermissionsForUser } from '~/lib/permissions/repository';

/**
 * B0-449 — the effective/act-as-aware actor for a `/api/bex/*` request, used for *authorization and
 * scoping* ("what can this request see/do"). Deliberately independent from
 * `~/lib/conversations/conversation-owner.ts`'s `resolveConversationOwnerUserId`, which resolves the
 * true authenticated owner (ignoring act-as) used only for stamping ownership on newly created rows.
 * Never conflate the two.
 */
export type BexActor =
  | { kind: 'user'; userId: string; canViewAll: boolean }
  | { kind: 'service' }
  | null;

/**
 * Resolves which credential authorizes the request and, for a signed-in user, their effective
 * (act-as-aware) user id and whether they hold `bex.chat.view-all`.
 *
 * This re-checks `hasBexSession()` / `authenticateApiToken()` rather than calling
 * `resolveBexActor()` in `~/lib/api/bex-api-auth.ts` directly: that helper's return shape
 * (`'session' | 'service' | null`) tells the caller *which* credential matched but carries neither a
 * user id nor a permission bundle, and both are required here. Re-checking the same two conditions is
 * a small, intentional duplication rather than layering a second lookup on top of that result.
 *
 * Uses the pure `hasPermission` helper from `~/lib/permissions/permissions-server.ts` — not
 * `requirePermission`, which is shadow-gated by `BEX_PERMISSIONS_ENFORCED` — because chat privacy
 * scoping must not fail open while that flag is off.
 */
export async function getBexActor(request: Request): Promise<BexActor> {
  if (await hasBexSession()) {
    const user = await getUserOrDefault();
    const userId = (user as { USER_ID?: string } | null)?.USER_ID;
    if (!userId) {
      // A NextAuth session exists but the act-as/auth-user cookie is missing or stale — treat
      // conservatively as unauthenticated rather than guessing at scope.
      return null;
    }

    const bundle = await getPermissionsForUser(userId);
    const canViewAll = hasPermission(bundle.permissions, PERMISSIONS.BEX_CHAT_VIEW_ALL);
    return { kind: 'user', userId, canViewAll };
  }

  const auth = await authenticateApiToken(request);
  return auth.ok ? { kind: 'service' } : null;
}
