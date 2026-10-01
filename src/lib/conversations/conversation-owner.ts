import { getServerSession } from 'next-auth';

import { authOptions } from '~/lib/auth';
import { logWarn } from '~/lib/observability/logger';
import { getUser } from '~/lib/permissions/repository';

/**
 * B0-449/450 — the *true authenticated owner*, ignoring act-as. Deliberately independent from
 * `~/lib/api/bex-actor.ts`'s `getBexActor`, which resolves the act-as-aware effective actor used
 * for authorization/scoping.
 *
 * **Stamping** (B0-1084 — reverses the B0-449 rule): a conversation created while an admin is
 * "Acting as" another user is now owned by the acted-as user (`user_id = actor.userId`), so it
 * behaves as that user's own conversation — it shows in their sidebar and stays sendable. The true
 * session user this function returns is recorded in `agent_conversations.acted_by_user_id` instead,
 * which preserves the audit trail B0-449 was protecting (who really typed it). See
 * `resolveConversationStamp` below.
 *
 * **Access checks** (B0-841): the true owner is ALSO consulted, alongside the act-as-aware actor,
 * when deciding whether a request may read/continue/delete an *existing* conversation (see
 * `actorMayAccessConversation` in `~/app/api/bex/conversations/[id]/route.ts` and the `allowed`
 * check in `~/app/api/bex/chat/stream/route.ts`). Since B0-1084 this only matters for rows created
 * while acting-as before that ticket, which were stamped with the admin's own id.
 *
 * Never throws, never blocks a turn: any failure (no session, no matching `app_user` row, a
 * repository error) resolves to `null`, which stamping treats as "not acting-as" (no
 * `acted_by_user_id`) and access-check callers treat as "this fallback does not apply" (falls
 * through to the actor-based checks).
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

/**
 * B0-1084 — ownership fields for a conversation a signed-in user creates: always owned by the
 * act-as-aware actor, with `actedByUserId` set to the true session user only when they differ
 * (i.e. an admin acting as someone else). `null` when not acting-as or the true owner is unresolved.
 */
export function resolveConversationStamp(
  actorUserId: string,
  trueOwnerUserId: string | null,
): { userId: string; actedByUserId: string | null } {
  return {
    userId: actorUserId,
    actedByUserId:
      trueOwnerUserId !== null && trueOwnerUserId !== actorUserId ? trueOwnerUserId : null,
  };
}
