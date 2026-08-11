/**
 * B0-418 — the run's own measurements, rendered in the trace page header: model tag,
 * retrieval similarity, timing breakdown, token usage and the validator's verdict.
 *
 * Every value is read from the run's `final_output` / `user_input` by
 * `~/lib/observability/run-payload` and degrades to an explicit "n/a": coverage is
 * partial by row (token usage and retrieved chunks were added later, and older runs
 * legitimately have gaps), so a blank or a bare 0 would read as a real measurement.
 */

import { Badge } from '~/components/ui/badge';
import { formatSimilarityValue } from '~/lib/tests/format';

import type { RunPayloadView } from '~/lib/observability/run-payload';

const NA = 'n/a';

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatSearchMs(value: number | null): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(1)} ms`
    : NA;
}

function Field({
  hint,
  label,
  value,
}: {
  hint?: string | null;
  label: string;
  value: string;
}) {
  const isEmpty = value === NA;
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd
        className={
          isEmpty
            ? 'text-xs text-slate-400'
            : 'font-mono text-xs tabular-nums text-slate-800'
        }
      >
        {value}
      </dd>
      {hint ? <p className="text-[0.65rem] text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function RunPayloadSummary({ payload }: { payload: RunPayloadView }) {
  const { modelTag, similarity, timing, usage, validation } = payload;

  return (
    <div className="mt-6 space-y-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
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

      <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
          Validator
        </p>
        {validation ? (
          <>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge
                className={
                  validation.approved
                    ? 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900'
                    : 'border-destructive/45 bg-destructive/10 text-destructive'
                }
                variant="outline"
              >
                {validation.approved ? 'approved' : 'not approved'}
              </Badge>
              <Badge className="tabular-nums" variant="outline">
                confidence {validation.confidence.toFixed(2)}
              </Badge>
              {validation.requires_human_review ? (
                <Badge
                  className="border-amber-600/45 bg-amber-600/12 text-amber-900"
                  variant="outline"
                >
                  human review required
                </Badge>
              ) : null}
            </div>
            {validation.issues.length > 0 ? (
              <ul className="mt-3 space-y-1">
                {validation.issues.map((issue, index) => (
                  <li
                    className="break-words font-mono text-xs text-slate-700"
                    key={`${index}:${issue}`}
                  >
                    {issue}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-slate-500">No issues reported.</p>
            )}
          </>
        ) : (
          <p className="mt-1.5 text-xs text-slate-400">
            n/a — no validator verdict recorded on this run.
          </p>
        )}
      </div>
    </div>
  );
}
