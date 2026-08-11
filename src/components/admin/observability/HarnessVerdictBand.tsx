/**
 * B0-419 — the harness verdict for a single execution, shown directly under the trace header.
 *
 * Rendered only when `getHarnessContextForRun` resolves. Live Bex chat runs and runs whose test data
 * was deleted get no band at all rather than an empty one, so this component never has to represent
 * "not a harness run".
 *
 * The answer and the ideal response sit side by side with **no character diff**, on purpose: both
 * are free-form prose, so a character diff would flag every harmless rewording and bury the real
 * differences in noise. Semantic comparison is `ItemAIReviewButton`'s job (extended by B0-420).
 *
 * Both `test_items.priority` and `test_items.ideal_response` are null for every row in the database
 * today, so "no priority, no ideal response" is the *normal* rendering, not an edge case: the badge
 * row is a flat list of independent badges (dropping one leaves no gap or dangling separator) and the
 * ideal-response pane states its own absence instead of collapsing to blank space.
 *
 * Prompt, answer and ideal response are rendered verbatim and untruncated — they can carry regulated
 * figures (oz/gal, ppm, contact times) that must not be reformatted.
 */

import { Badge } from '~/components/ui/badge';
import { formatExpectedShouldAnswerLabel, formatSimilarityValue } from '~/lib/tests/format';
import { formatDurationSeconds } from '~/lib/utils/time';

import type { HarnessRunContext } from '~/lib/observability/harness-linkage';

const PASS_BADGE_CLASS_NAME =
  'border-emerald-600/45 bg-emerald-600/12 text-emerald-900';

export function HarnessVerdictBand({
  answerText,
  context,
}: {
  /** `final_output.answerText` from the run itself; the harness row is the fallback. */
  answerText: string | null;
  context: HarnessRunContext;
}) {
  const {
    elapsedMs,
    errorMessage,
    expectedShouldAnswer,
    idealResponse,
    passed,
    priority,
    prompt,
    responseText,
    rowIndex,
    similarity,
    testName,
  } = context;

  // The trace's own payload is authoritative for the answer; the harness copy covers runs whose
  // `final_output` never recorded one, and the error message covers runs that produced neither.
  const answer = answerText ?? responseText ?? null;

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
            Harness verdict
          </p>
          <h2 className="mt-2 text-lg font-semibold text-slate-900">
            {testName || 'Test run'} · Row {rowIndex}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            className={passed ? PASS_BADGE_CLASS_NAME : undefined}
            variant={passed ? 'outline' : 'destructive'}
          >
            {passed ? 'Passed' : 'Failed'}
          </Badge>
          <Badge variant="outline">
            Expected answer: {formatExpectedShouldAnswerLabel(expectedShouldAnswer)}
          </Badge>
          <Badge variant="outline">Row {rowIndex}</Badge>
          {priority !== null ? (
            <Badge
              title={`Priority ${priority} — lower = more important`}
              variant="secondary"
            >
              P{priority}
            </Badge>
          ) : null}
          {similarity !== null ? (
            <Badge className="tabular-nums" variant="outline">
              similarity {formatSimilarityValue(similarity)}
            </Badge>
          ) : null}
          <Badge className="tabular-nums" variant="outline">
            {formatDurationSeconds(elapsedMs)}
          </Badge>
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-slate-100 bg-slate-50/70 p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
          Prompt
        </p>
        <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-slate-800">
          {prompt}
        </p>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
            Answer (this run)
          </p>
          {answer ? (
            <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-slate-800">
              {answer}
            </p>
          ) : errorMessage ? (
            <p className="mt-1.5 whitespace-pre-wrap break-words font-mono text-xs text-destructive">
              {errorMessage}
            </p>
          ) : (
            <p className="mt-1.5 text-sm text-slate-400">
              n/a — this execution recorded no answer.
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-dashed border-slate-200 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
            Ideal response
          </p>
          {idealResponse ? (
            <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-slate-800">
              {idealResponse}
            </p>
          ) : (
            <p className="mt-1.5 text-sm text-slate-400">
              No ideal response is recorded for this prompt, so there is nothing to
              compare the answer against yet.
            </p>
          )}
        </div>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        Shown side by side, not diffed — both are free-form prose. Use AI review for a
        semantic comparison.
      </p>
    </section>
  );
}
