import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import type { ThursdayScorecardSnapshot } from '~/lib/tests/thursday-scorecard-schemas';

/**
 * B0-1170 — "Executive highlights" and "Data notes & review flags", rendered under the scorecard
 * table and INSIDE the PDF capture root (they are part of the report card). Every bullet is a
 * deterministic sentence templated by the loader from persisted values; this component authors
 * nothing. The muted footer line is the mock's explanatory text, verbatim. Server-safe.
 */

const HIGHLIGHTS_FOOTER =
  'This report card summarizes finalized agent-evaluation reports. It performs no grading, changes no methodology and recalculates no score — every grade, score, failure count and supporting metric is transcribed from the source evaluation, which remains the source of truth.';

const NOTES_FOOTER =
  'Grade, score (out of 100) and failed prompts are the content result; pass rate is the share of prompts at or above the pass mark. Speed score, average time to first token, similarity and evaluator confidence are independent supporting metrics — none contributes to the grade or the score. — means the source evaluation did not report that metric; it is never read as zero.';

function ScorecardCard({
  title,
  items,
  footer,
  historyHref,
}: {
  title: string;
  items: readonly string[];
  footer: string;
  historyHref: string | null;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-5">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">Nothing to highlight for this sweep.</p>
      ) : (
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-slate-700">
          {items.map((item, index) => (
            <li key={`${index}:${item}`}>{item}</li>
          ))}
        </ul>
      )}
      <p className="mt-4 border-t border-slate-200 pt-3 text-xs italic text-slate-500">{footer}</p>
      {historyHref ? (
        <Link
          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-sky-700 underline-offset-2 hover:underline"
          href={historyHref}
        >
          View all Thursday report cards <ArrowRight className="size-3" />
        </Link>
      ) : null}
    </div>
  );
}

export function ThursdayScorecardCards({
  snapshot,
  historyHref = '/admin/tests/reports/scorecards',
}: {
  snapshot: ThursdayScorecardSnapshot;
  /** Link under each card's footer; `null` on the standalone card page so it never links to itself. */
  historyHref?: string | null;
}) {
  return (
    <div className="mt-6 grid gap-4 md:grid-cols-2">
      <ScorecardCard
        footer={HIGHLIGHTS_FOOTER}
        historyHref={historyHref}
        items={snapshot.highlights}
        title="Executive highlights"
      />
      <ScorecardCard
        footer={NOTES_FOOTER}
        historyHref={historyHref}
        items={snapshot.notes}
        title="Data notes & review flags"
      />
    </div>
  );
}
