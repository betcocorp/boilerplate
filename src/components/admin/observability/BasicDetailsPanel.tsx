'use client';

import { ChevronDownIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { WorkflowRunTrace } from '~/lib/observability/prompt-insights';
import { RunPayloadView } from '~/lib/observability/run-payload';
import { formatSimilarityValue } from '~/lib/tests/format';
import { cn } from '~/lib/utils';
import { formatEasternTimestamp } from '~/lib/utils/time';
import { RunAttributionBadge } from './RunAttributionBadge';
import { Field } from './RunPayloadSummary';

const NA = 'n/a';

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatSearchMs(value: number | null): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(1)} ms`
    : NA;
}

const BasicDetailsPanel = ({
  trace,
  run,
  payload,
}: {
  trace: WorkflowRunTrace | null;
  run: WorkflowRunTrace['run'];
  payload: RunPayloadView;
}) => {
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const { modelTag, similarity, timing, usage } = payload;

  return (
    <div className="mt-8 rounded-2xl border border-slate-100 bg-slate-50/70 p-4">
      <div
        className="flex items-center justify-between"
        onClick={() => setIsDetailsOpen(!isDetailsOpen)}
      >
        <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
          Basic details
        </h3>
        <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
      </div>
      <div className={cn('mt-4', isDetailsOpen ? 'block' : 'hidden')}>
        <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-0.5">
            {/* B0-338 — who asked for this run. */}
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              Asked by
            </dt>
            <dd className="text-sm">
              <RunAttributionBadge
                attribution={trace?.attribution ?? { kind: 'unknown' }}
              />
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              Created
            </dt>
            <dd className="font-mono text-xs text-slate-800">
              {formatEasternTimestamp(run.created_at)}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              Updated
            </dt>
            <dd className="font-mono text-xs text-slate-800">
              {formatEasternTimestamp(run.updated_at)}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              Conversation
            </dt>
            <dd className="break-all font-mono text-xs">
              {run.conversation_id ? (
                <Link
                  href={`/admin/bex?conversationId=${encodeURIComponent(run.conversation_id)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:text-blue-800 hover:underline"
                >
                  {run.conversation_id}
                </Link>
              ) : (
                <span className="text-slate-500">—</span>
              )}
            </dd>
          </div>
        </dl>

        <div className="mt-4 space-y-4">
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4 mb-8">
            <Field label="Model" value={modelTag ?? NA} />
            <Field
              hint={similarity ? 'across all retrieved sources' : null}
              label="Similarity min / avg / max"
              value={
                similarity
                  ? `${formatSimilarityValue(similarity.min)} / ${formatSimilarityValue(
                      similarity.avg,
                    )} / ${formatSimilarityValue(similarity.max)}`
                  : NA
              }
            />
            <Field
              label="Tool rounds"
              value={timing ? formatCount(timing.toolRounds) : NA}
            />
            <Field label="Cache source" value={timing?.cacheSource ?? NA} />
            <Field
              label="RAG search"
              value={timing ? formatSearchMs(timing.searchMs) : NA}
            />
            <Field
              hint={
                usage
                  ? `${formatCount(usage.promptTokens)} prompt · ${formatCount(
                      usage.completionTokens,
                    )} completion · ${
                      typeof usage.cachedPromptTokens === 'number'
                        ? `${formatCount(usage.cachedPromptTokens)} cached`
                        : 'cached n/a'
                    }`
                  : null
              }
              label="Token usage"
              value={usage ? `${formatCount(usage.totalTokens)} total` : NA}
            />
          </dl>
        </div>
      </div>
    </div>
  );
};

export default BasicDetailsPanel;
