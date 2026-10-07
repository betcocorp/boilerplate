/**
 * B0-533 — turn-by-turn view of one conversation (epic B0-526). Server component; the only
 * client island is `CollapsibleMarkdown` (expand/collapse of a long answer).
 *
 * One card per turn: the user message with its pause (`user_pause_ms` + `pause_tier`), the
 * assistant reply with its `processing_ms`, and the matched workflow run — routing decision,
 * confidence, status, version stamps, tool calls, and a link to the full single-run trace.
 */

import Link from 'next/link';

import { CollapsibleMarkdown } from '~/components/admin/conversations/CollapsibleMarkdown';
import { formatConfidence, formatMs, formatShare } from '~/components/admin/conversations/format';
import { AppVersionBadge } from '~/components/admin/tests/AppVersionBadge';
import { PromptBundleVersionBadge } from '~/components/admin/tests/PromptBundleVersionBadge';
import { Badge } from '~/components/ui/badge';
import { getAgentBadgeClassName } from '~/lib/bex/agent-badge';
import { formatEasternTimestamp } from '~/lib/utils/time';
import { shortHash } from '~/lib/workflows/product-support/prompt-version';

import type {
  ConversationTurn,
  ConversationTurnRun,
  ConversationTurnTotals,
} from '~/lib/conversations/admin-conversation-browser';
import type { PauseTier } from '~/lib/conversations/turn-metrics';

const PAUSE_TIER_CLASSNAMES: Record<PauseTier, string> = {
  instant: 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900',
  short: 'border-sky-600/45 bg-sky-600/12 text-sky-900',
  medium: 'border-amber-600/45 bg-amber-600/12 text-amber-900',
  long: 'border-orange-600/45 bg-orange-600/12 text-orange-900',
  abandoned: 'border-red-600/45 bg-red-600/12 text-red-900',
};

function statusBadgeClassName(status: string): string {
  switch (status) {
    case 'completed':
      return 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900';
    case 'failed':
      return 'border-red-600/45 bg-red-600/12 text-red-900';
    case 'running':
      return 'border-sky-600/45 bg-sky-600/12 text-sky-900';
    default:
      return '';
  }
}

/** Σ agent vs Σ pause as a two-segment bar. Renders nothing when neither sum exists. */
export function AgentPauseProportionBar({ totals }: { totals: ConversationTurnTotals }) {
  if (totals.agentShare === null) {
    return (
      <p className="text-xs text-slate-500">
        No turn in this conversation recorded processing or pause time.
      </p>
    );
  }
  const agentPct = Math.round(totals.agentShare * 100);
  return (
    <div className="space-y-1.5">
      <div
        aria-label={`Agent time ${agentPct}% of measured time, user pause ${100 - agentPct}%`}
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100"
        role="img"
      >
        <div className="h-full bg-sky-600" style={{ width: `${agentPct}%` }} />
        <div className="h-full bg-amber-400" style={{ width: `${100 - agentPct}%` }} />
      </div>
      <div className="flex flex-wrap justify-between gap-2 text-xs text-slate-600">
        <span>
          <span className="mr-1 inline-block size-2 rounded-full bg-sky-600 align-middle" />
          Agent {formatMs(totals.agentMs)} ({formatShare(totals.agentShare)})
        </span>
        <span>
          <span className="mr-1 inline-block size-2 rounded-full bg-amber-400 align-middle" />
          User pause {formatMs(totals.pauseMs)} ({formatShare(1 - totals.agentShare)})
        </span>
      </div>
    </div>
  );
}

function RunSummary({ run }: { run: ConversationTurnRun }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge className={statusBadgeClassName(run.status)} variant="outline">
          {run.status}
        </Badge>
        {run.routingDecision ? (
          <Badge className={getAgentBadgeClassName(run.routingDecision)} variant="outline">
            {run.routingDecision}
          </Badge>
        ) : (
          <Badge className="border-dashed text-slate-500" variant="outline">
            no routing decision
          </Badge>
        )}
        <Badge className="tabular-nums" title="workflow_runs.confidence" variant="outline">
          confidence {formatConfidence(run.confidence)}
        </Badge>
        <AppVersionBadge appVersion={run.appVersion} />
        <PromptBundleVersionBadge
          summary={
            run.promptBundleVersion
              ? { kind: 'single', value: run.promptBundleVersion }
              : { kind: 'none' }
          }
        />
        {run.promptVersion ? (
          <Badge
            className="font-mono"
            title={`promptVersion (specialist prompt): ${run.promptVersion}`}
            variant="outline"
          >
            prompt {shortHash(run.promptVersion)}
          </Badge>
        ) : null}
        {run.matchedBy === 'timestamp' ? (
          <Badge
            className="border-amber-600/45 bg-amber-600/12 text-amber-900"
            title="No assistant message carries this run's id (the run failed before a reply was written); it was matched by its timestamp falling between this user message and the next."
            variant="outline"
          >
            matched by time
          </Badge>
        ) : null}
      </div>

      {run.planner ? (
        <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-slate-500">
            Routing decision
          </p>
          <p className="mt-1 text-sm text-slate-800">
            {run.planner.decision ? (
              <Badge className={getAgentBadgeClassName(run.planner.decision)} variant="outline">
                {run.planner.decision}
              </Badge>
            ) : null}
            {typeof run.planner.classifierConfidence === 'number' ? (
              <span className="ml-2 text-xs tabular-nums text-slate-600">
                classifier confidence {formatConfidence(run.planner.classifierConfidence)}
                {run.planner.classifierSource ? ` (${run.planner.classifierSource})` : ''}
              </span>
            ) : null}
          </p>
          {run.planner.rationale ? (
            <p className="mt-1.5 text-xs leading-5 text-slate-600">{run.planner.rationale}</p>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-slate-500">No planner step recorded for this run.</p>
      )}

      <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-slate-500">
          Tool calls
        </p>
        {run.toolCalls.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500">
            No tool trace persisted on the agent step for this run.
          </p>
        ) : (
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {run.toolCalls.map((call, index) => (
              <li
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs"
                key={`${call.toolName}-${index}`}
                title={call.origin ? `origin: ${call.origin}` : undefined}
              >
                <span className="font-mono">{call.toolName}</span>
                <span
                  className={call.ok ? 'text-emerald-700' : 'text-red-700'}
                >
                  {call.ok ? 'ok' : 'failed'}
                </span>
                <span className="tabular-nums text-slate-500">{formatMs(call.durationMs)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {run.steps.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5 text-[0.7rem] text-slate-600">
          {run.steps.map((step, index) => (
            <li
              className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5"
              key={`${step.name}-${index}`}
            >
              <span className="font-mono">{step.name}</span>
              <span className="tabular-nums text-slate-500">{formatMs(step.durationMs)}</span>
              {step.status !== 'completed' ? (
                <span className="text-red-700">{step.status}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <Link
        className="inline-flex text-xs font-medium text-sky-700 underline-offset-2 hover:underline"
        href={`/admin/observability/${run.id}`}
      >
        Open full run trace →
      </Link>
    </div>
  );
}

export function ConversationTurnTimeline({ turns }: { turns: ConversationTurn[] }) {
  if (turns.length === 0) {
    return (
      <section className="rounded-3xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
        This conversation has no user messages yet.
      </section>
    );
  }

  return (
    <ol className="flex flex-col gap-6">
      {turns.map((turn) => (
        <li
          className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
          id={`turn-${turn.index}`}
          key={turn.user.id}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="inline-flex size-8 items-center justify-center rounded-full bg-slate-950 text-sm font-semibold text-white">
                {turn.index}
              </span>
              <h2 className="text-base font-semibold text-slate-900">Turn {turn.index}</h2>
            </div>
            <span className="font-mono text-xs text-slate-500">
              {formatEasternTimestamp(turn.user.createdAt)}
            </span>
          </div>

          <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="min-w-0 space-y-4">
              {/* User message */}
              <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                    User
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge
                      className="tabular-nums"
                      title="user_pause_ms — time between Bex's previous reply and this message. Empty on the first turn."
                      variant="outline"
                    >
                      pause {formatMs(turn.user.pauseMs)}
                    </Badge>
                    {turn.user.pauseTier ? (
                      <Badge
                        className={PAUSE_TIER_CLASSNAMES[turn.user.pauseTier]}
                        title="pause_tier (B0-531)"
                        variant="outline"
                      >
                        {turn.user.pauseTier}
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-800">
                  {turn.user.text || '—'}
                </p>
              </div>

              {/* Assistant message */}
              <div className="rounded-2xl border border-slate-100 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                    Bex
                  </p>
                  {turn.assistant ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge
                        className="tabular-nums"
                        title="processing_ms — time from this user message to the assistant reply."
                        variant="outline"
                      >
                        processing {formatMs(turn.assistant.processingMs)}
                      </Badge>
                      {turn.assistant.model ? (
                        <Badge className="font-mono" variant="outline">
                          {turn.assistant.model}
                        </Badge>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {turn.assistant ? (
                  <div className="mt-2">
                    <CollapsibleMarkdown text={turn.assistant.text || '—'} />
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-slate-500">
                    No assistant reply was recorded for this turn.
                  </p>
                )}
              </div>
            </div>

            {/* Matched run */}
            <div className="min-w-0 rounded-2xl border border-slate-100 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                Workflow run
              </p>
              <div className="mt-2">
                {turn.run ? (
                  <RunSummary run={turn.run} />
                ) : (
                  <p className="text-sm text-slate-500">No run recorded for this turn.</p>
                )}
              </div>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
