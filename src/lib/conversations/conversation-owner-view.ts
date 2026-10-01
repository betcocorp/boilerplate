import type { BexActor } from '~/lib/api/bex-actor';
import type { ConversationOwner } from '~/types/bex';

/**
 * B0-451 — the wire-shape owner field for a conversation row, as consumed by the admin sidebar:
 * `'admin'` for test-runner rows with no resolvable test name, `null` for legacy/unresolved
 * `source = 'chat'` rows with no `user_id`, the resolved `{ name, email, userId }` for a real user,
 * or (B0-645) `{ kind: 'test', title }` for a test-runner row whose source test is resolvable.
 *
 * `userId` is a deliberate addition beyond the ticket's literal `{ name, email }` shape: the admin
 * sidebar's "filter by user" dropdown must send a real `agent_conversations.user_id` back as the
 * `?userFilter=` query param (it is passed straight through to `listAllConversations`'s
 * `.eq('user_id', ...)`), and there is no other field on this object a client could use for that.
 * Without it, the filter control has no value to select.
 *
 * Re-exported from `~/types/bex` (the single source of truth for this shape) rather than
 * duplicated here.
 */
export type ConversationOwnerField = ConversationOwner;

export type ConversationOwnerAttribution = {
  owner: ConversationOwnerField;
  source: 'chat' | 'test_run';
  isOwner: boolean;
};

type ConversationOwnerRow = {
  source: string;
  user_id: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
  /** B0-645 — the source test's name, stamped at conversation-creation time for `test_run` rows. */
  test_name?: string | null;
};

/**
 * `agent_conversations.source` is a plain-string DB column (see B0-448); anything other than the
 * literal `'test_run'` is treated as `'chat'` rather than left as an open string, since that is the
 * only other value B0-448/450 ever write.
 */
function normalizeSource(source: string): 'chat' | 'test_run' {
  return source === 'test_run' ? 'test_run' : 'chat';
}

/**
 * Strict ownership check independent of `bex.chat.view-all` — deliberately NOT the same as
 * `actorMayAccessConversation` in `[id]/route.ts` (which also returns true for view-all/service).
 * A service actor has no user identity, so it never owns anything.
 */
export function resolveIsOwner(
  actor: Exclude<BexActor, null>,
  ownerUserId: string | null,
): boolean {
  return actor.kind === 'user' && ownerUserId === actor.userId;
}

/**
 * Maps a conversation row (plus its `listAllConversations`/single-row owner-join fields) and the
 * requesting actor to the `owner` / `source` / `isOwner` wire fields. Only used on the
 * view-all-or-service path — the caller's-own-rows path (`listConversationsForUser`) already knows
 * every row is `owner: null, isOwner: true` by construction and skips this helper entirely.
 */
export function resolveConversationOwnerAttribution(
  row: ConversationOwnerRow,
  actor: Exclude<BexActor, null>,
): ConversationOwnerAttribution {
  const source = normalizeSource(row.source);
  const isOwner = resolveIsOwner(actor, row.user_id);

  if (source === 'test_run') {
    // B0-645 — prefer the source test's name (stamped at creation, or backfilled) when it's
    // resolvable; fall back to the generic 'admin' badge for rows the backfill couldn't join
    // (e.g. no matching test_result_items row).
    if (row.test_name) {
      return { owner: { kind: 'test', title: row.test_name }, source, isOwner };
    }
    return { owner: 'admin', source, isOwner };
  }

  if (!row.user_id) {
    return { owner: null, source, isOwner };
  }

  return {
    owner: {
      // Both `user_name` and `name` can be null (no app_user match, or a row with neither set);
      // fall back to the email, then a literal label — distinct from the `null` ("Unattributed")
      // case above, which means no user_id at all.
      name: row.ownerName ?? row.ownerEmail ?? 'Unknown user',
      email: row.ownerEmail ?? null,
      userId: row.user_id,
    },
    source,
    isOwner,
  };
}
