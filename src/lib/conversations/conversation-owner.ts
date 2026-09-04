import { getServerSession } from 'next-auth';

import { authOptions } from '~/lib/auth';
import { logWarn } from '~/lib/observability/logger';
import { getUser } from '~/lib/permissions/repository';

/**
 * B0-449/450 — the *true authenticated owner*, ignoring act-as. Deliberately independent from
 * `~/lib/api/bex-actor.ts`'s `getBexActor`, which resolves the act-as-aware effective actor used
 * for authorization/scoping.
 *
 * **Stamping** (unchanged): `agent_conversations.user_id` is destined to become the key for
 * per-user RLS. If an admin acting-as another user created a conversation and it were attributed to
 * the acted-as user, that user would later gain read access (via RLS) to a transcript they never
 * wrote — and since the admin's own permissions may have surfaced content the acted-as user cannot
 * see, that would be a leak, not a cosmetic mislabel, and it is unfixable after the fact (nothing on
 * the row records who really typed it). So ownership on newly created rows always resolves from the
 * real NextAuth session, never the act-as/"selected-user" cookie — this function is never called
 * with the actor in mind for stamping, and that stays true-owner-only.
 *
 * **Access checks** (B0-841): the true owner this function returns is now ALSO consulted, in
 * addition to the act-as-aware actor, when deciding whether a request may read/continue/delete an
 * *existing* conversation (see `actorMayAccessConversation` in
 * `~/app/api/bex/conversations/[id]/route.ts` and the `allowed` check in
 * `~/app/api/bex/chat/stream/route.ts`). Without this, a conversation created while acting-as — always
 * stamped with the true admin's id per the rule above — could never be matched by that same admin's
 * later act-as-aware `actor.userId` (the acted-as user), locking them out of a conversation they just
 * created. The two uses (stamping vs. access) are related but not identical: stamping never looks at
 * the actor at all; access checks accept a match against *either* identity.
 *
 * Never throws, never blocks a turn: any failure (no session, no matching `app_user` row, a
 * repository error) resolves to `null`, which stamping callers treat as "leave user_id unset" (DB
 * default: `user_id` null, `source` 'chat') and access-check callers treat as "this fallback does not
 * apply" (falls through to the actor-based checks).
 */
export async function resolveConversationOwnerUserId(): Promise<string | null> {
  try {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email?.trim();
    if (!email) {
      return null;
    }

    const result = await getUser(email);
    const userId = result.data[0]?.USER_ID;
    if (!userId) {
      logWarn('conversations.owner_unresolved', {
        reason: 'no-app_user-row',
        email,
      });
      return null;
    }

    return userId;
  } catch (error) {
    logWarn('conversations.owner_unresolved', {
      reason: 'lookup-failed',
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
