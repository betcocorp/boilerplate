/**
 * B0-533 — owner + acted-by rendering for a conversation row. A user owner reuses
 * `RunAttributionBadge` so a person reads identically here and on the runs list; the acting
 * admin (B0-1084 `acted_by_user_id`) is a secondary chip, never shown in place of the owner.
 */

import { RunAttributionBadge } from '~/components/admin/observability/RunAttributionBadge';
import { Badge } from '~/components/ui/badge';

import type {
  ConversationOwnerDisplay,
  ConversationPerson,
} from '~/lib/conversations/admin-conversation-browser';

const TEST_BADGE_CLASSNAME = 'border-indigo-600/45 bg-indigo-600/12 text-indigo-900';
const ACTED_BY_CLASSNAME = 'border-amber-600/45 bg-amber-600/12 text-amber-900';

function personLabel(person: ConversationPerson): string {
  return person.displayName ?? person.email ?? person.userId;
}

export function ConversationOwnerBadge({
  owner,
  actedBy,
  maxChars,
}: {
  owner: ConversationOwnerDisplay;
  actedBy: ConversationPerson | null;
  /** Truncate the displayed owner name to this many characters (full value stays in `title`). */
  maxChars?: number;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {owner.kind === 'user' ? (
        <RunAttributionBadge
          attribution={{
            kind: 'user',
            userId: owner.person.userId,
            displayName: owner.person.displayName,
            email: owner.person.email,
          }}
          maxChars={maxChars}
        />
      ) : owner.kind === 'test' ? (
        <Badge
          className={TEST_BADGE_CLASSNAME}
          title={owner.testName ? `Test harness: ${owner.testName}` : 'Test harness (test name not recorded)'}
          variant="outline"
        >
          {owner.testName
            ? maxChars && owner.testName.length > maxChars
              ? `${owner.testName.slice(0, maxChars)}…`
              : owner.testName
            : 'Test harness'}
        </Badge>
      ) : (
        <RunAttributionBadge attribution={{ kind: 'unknown' }} />
      )}
      {actedBy ? (
        <Badge
          className={ACTED_BY_CLASSNAME}
          title={`Typed by ${personLabel(actedBy)} while "Acting as" the owner (acted_by_user_id)`}
          variant="outline"
        >
          via {maxChars ? personLabel(actedBy).slice(0, maxChars) : personLabel(actedBy)}
        </Badge>
      ) : null}
    </span>
  );
}
