/**
 * B0-533 — turn-by-turn detail for one conversation (epic B0-526). Thin route: the header reads
 * the repository's `ConversationDetail`, the body is `ConversationTurnTimeline`.
 */

import Link from 'next/link';
import { connection } from 'next/server';

import { ConversationOwnerBadge } from '~/components/admin/conversations/ConversationOwnerBadge';
import {
  AgentPauseProportionBar,
  ConversationTurnTimeline,
} from '~/components/admin/conversations/ConversationTurnTimeline';
import { SOURCE_BADGES } from '~/components/admin/conversations/ConversationsTable';
import { formatMs } from '~/components/admin/conversations/format';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { getConversationTurns } from '~/lib/conversations/admin-conversation-browser';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';
import { formatEasternTimestamp } from '~/lib/utils/time';

export const metadata = {
  title: 'Conversation turns | Betco BEX',
  description: 'Per-turn routing decision, agent time vs pause time, tool calls and confidence for one Bex conversation.',
};

type PageProps = {
  params: Promise<{ conversationId: string }>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdminConversationTurnsPage({ params }: PageProps) {
  await requirePagePermission(
    PERMISSIONS.BEX_CHAT_VIEW_ALL,
    'GET /admin/bex/conversations/[conversationId]',
  );
  await connection();
  const { conversationId } = await params;

  let detail: Awaited<ReturnType<typeof getConversationTurns>> = null;
  let loadError: string | null = null;

  if (UUID_PATTERN.test(conversationId)) {
    try {
      detail = await getConversationTurns(conversationId);
    } catch (error) {
      loadError =
        error instanceof Error
          ? error.message
          : 'Unable to load this conversation. If this persists, check the Supabase service-role configuration.';
    }
  }

  const conversation = detail?.conversation ?? null;
  const sourceBadge = conversation ? (SOURCE_BADGES[conversation.source] ?? SOURCE_BADGES.chat) : null;
  const matchedRuns = detail ? detail.turns.filter((turn) => turn.run !== null).length : 0;

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
                Conversations
              </p>
              <h1 className="mt-2 break-words text-3xl font-semibold tracking-tight text-slate-950">
                {conversation?.title ?? 'Conversation'}
              </h1>
              <p className="mt-2 break-all font-mono text-xs text-slate-500">{conversationId}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {conversation ? (
                <Button asChild size="sm" variant="outline">
                  <Link
                    href={`/admin/bex?conversationId=${encodeURIComponent(conversationId)}`}
                    title="Open this conversation in the Bex chat UI"
                  >
                    Open in Bex
                  </Link>
                </Button>
              ) : null}
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/bex/conversations">All conversations</Link>
              </Button>
            </div>
          </div>

          {conversation && sourceBadge ? (
            <>
              <div className="mt-6 flex flex-wrap items-center gap-2">
                <Badge className={sourceBadge.className} variant="outline">
                  {sourceBadge.label}
                </Badge>
                {conversation.latestModel ? (
                  <Badge className="font-mono" title="agent_conversations.latest_model" variant="outline">
                    {conversation.latestModel}
                  </Badge>
                ) : null}
                <Badge className="tabular-nums" variant="outline">
                  {detail?.turns.length ?? 0} turn{detail?.turns.length === 1 ? '' : 's'}
                </Badge>
                <Badge
                  className="tabular-nums"
                  title="Turns with a matched workflow run"
                  variant="outline"
                >
                  {matchedRuns} run{matchedRuns === 1 ? '' : 's'} matched
                </Badge>
              </div>

              <dl className="mt-6 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div className="flex flex-col gap-0.5">
                  <dt className="text-xs uppercase tracking-wide text-slate-500">Owner</dt>
                  <dd>
                    <ConversationOwnerBadge
                      actedBy={conversation.actedBy}
                      owner={conversation.owner}
                    />
                  </dd>
                </div>
                <div className="flex flex-col gap-0.5">
                  <dt className="text-xs uppercase tracking-wide text-slate-500">Started</dt>
                  <dd className="font-mono text-xs text-slate-800">
                    {formatEasternTimestamp(conversation.startedAt)}
                  </dd>
                </div>
                <div className="flex flex-col gap-0.5">
                  <dt className="text-xs uppercase tracking-wide text-slate-500">Last activity</dt>
                  <dd className="font-mono text-xs text-slate-800">
                    {formatEasternTimestamp(conversation.lastActivityAt)}
                  </dd>
                </div>
                <div className="flex flex-col gap-0.5">
                  <dt className="text-xs uppercase tracking-wide text-slate-500">
                    Agent time / user pause
                  </dt>
                  <dd className="tabular-nums text-slate-800">
                    {formatMs(detail?.totals.agentMs)} / {formatMs(detail?.totals.pauseMs)}
                  </dd>
                </div>
              </dl>

              {detail ? (
                <div className="mt-6 rounded-2xl border border-slate-100 bg-slate-50/70 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                    Where the time went
                  </p>
                  <div className="mt-3">
                    <AgentPauseProportionBar totals={detail.totals} />
                  </div>
                </div>
              ) : null}

              {detail && (detail.orphanAssistantMessages > 0 || detail.unmatchedRunIds.length > 0) ? (
                <p className="mt-4 text-xs text-slate-500">
                  {detail.orphanAssistantMessages > 0
                    ? `${detail.orphanAssistantMessages} assistant message${detail.orphanAssistantMessages === 1 ? '' : 's'} preceded any user message and could not be paired. `
                    : ''}
                  {detail.unmatchedRunIds.length > 0
                    ? `${detail.unmatchedRunIds.length} run${detail.unmatchedRunIds.length === 1 ? '' : 's'} on this conversation matched no turn.`
                    : ''}
                </p>
              ) : null}
            </>
          ) : null}
        </section>

        {loadError ? (
          <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
            {loadError}
          </section>
        ) : null}

        {!loadError && !detail ? (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
            {UUID_PATTERN.test(conversationId)
              ? 'No conversation exists with this id (it may have been deleted).'
              : 'This is not a valid conversation id.'}
          </section>
        ) : null}

        {detail ? <ConversationTurnTimeline turns={detail.turns} /> : null}
      </main>
    </div>
  );
}
