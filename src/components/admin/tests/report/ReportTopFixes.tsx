import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';

import type {
  ReportEvaluatedCase,
  ReportMetricsData,
} from '~/lib/tests/report/data-schemas';
import { caseAnchorId } from '~/lib/tests/report/render';
import type {
  ReportSynthesis,
  Top3Recommendation,
} from '~/lib/tests/report/schemas';

/**
 * B0-589 — "Fix these three things": the report's action list.
 *
 * Two rules shape everything below.
 *
 * 1. **Regulated prose passes through verbatim.** `what`, `whyFirst`, `change`, `impact`,
 *    `affected` and `evidence` are generated text that routinely quotes dilution ratios, contact
 *    times, ppm and EPA/DIN numbers. They are rendered as-is — never parsed, rounded, unit-
 *    converted or shortened by string-slicing, and deliberately not `line-clamp`ed either.
 * 2. **Every count and chip in the tag row is derived from the ledger**, not from the prose. The
 *    case ids cited in `evidence` are resolved against `metrics.perCase`, and the tier/category/
 *    count chips come from the rows that resolve — so a tag row can never contradict the ledger.
 *
 * Note: `changePseudocode` (described in the ticket) does **not** exist on
 * `top3RecommendationSchema`, so no pseudocode disclosure is rendered here. Inventing one would
 * mean fabricating content the synthesizer never produced.
 */

/**
 * A cited case id as it appears in `evidence`: either a full UUID, or the 8-hex first segment the
 * synthesis model routinely shortens ids to (same shorthand `render.ts` linkifies in the Markdown).
 *
 * A bare 8-hex token is only treated as a citation when it actually resolves to a ledger row —
 * ordinary 8-digit runs in prose (dates, counts) are valid hex and would otherwise render as
 * fabricated "unresolved" chips. A full UUID is always treated as a citation, resolved or not.
 */
const CASE_ID_MENTION_PATTERN =
  /\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/gi;

/** A pattern that cites at least this share of the evaluated ledger is systemic on volume alone. */
const SYSTEMIC_LEDGER_SHARE = 0.25;

type CitedCase = {
  /** Dedupe key: the resolved ledger id, or the lower-cased mention when it does not resolve. */
  key: string;
  /** The citation exactly as written in `evidence`. */
  mention: string;
  /** The ledger row, or null when the cited id is not in `metrics.perCase`. */
  evaluated: ReportEvaluatedCase | null;
};

type FixSeverity = 'systemic' | 'recurring' | 'rare · severe';

export type ReportTopFixesProps = {
  /** Already-fetched synthesis slice — this component never fetches. */
  synthesis: Pick<ReportSynthesis, 'top3'>;
  /** Already-fetched metrics slice; `perCase` is the ledger every chip is derived from. */
  metrics: Pick<ReportMetricsData, 'perCase'>;
};

/** Resolves the case ids cited in `evidence` against the ledger, in order of first mention. */
function extractCitedCases(
  evidence: string,
  perCase: ReportEvaluatedCase[],
): CitedCase[] {
  if (!evidence) return [];

  const byId = new Map<string, ReportEvaluatedCase>();
  const byPrefix = new Map<string, ReportEvaluatedCase>();
  for (const item of perCase) {
    const id = item.id.trim().toLowerCase();
    if (!byId.has(id)) byId.set(id, item);
    const prefix = id.slice(0, 8);
    // First writer wins on a prefix collision; an ambiguous shorthand is not worth guessing at.
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, item);
  }

  const cited: CitedCase[] = [];
  const seen = new Set<string>();

  for (const match of evidence.matchAll(CASE_ID_MENTION_PATTERN)) {
    const mention = match[0];
    const normalized = mention.toLowerCase();
    const isFullId = normalized.includes('-');
    const evaluated =
      (isFullId ? byId.get(normalized) : byPrefix.get(normalized)) ?? null;

    // A shorthand that resolves to nothing is far more likely to be ordinary prose than a citation.
    if (!isFullId && !evaluated) continue;

    const key = evaluated ? evaluated.id : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    cited.push({ key, mention, evaluated });
  }

  return cited;
}

/** `Tier 1` … `Tier N` ascending, anything unparseable (e.g. `Unspecified`) last. */
function tierRank(tier: string): number {
  const match = /^tier\s+(\d+)$/i.exec(tier.trim());
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function uniqueTiers(cases: ReportEvaluatedCase[]): string[] {
  return [...new Set(cases.map((item) => item.tier))].sort(
    (a, b) => tierRank(a) - tierRank(b) || a.localeCompare(b),
  );
}

function uniqueCategories(cases: ReportEvaluatedCase[]): string[] {
  return [...new Set(cases.map((item) => item.category))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/**
 * The issue's character, derived from the resolved citations: spread across several categories (or
 * a large slice of the ledger) reads as systemic; more than one case is recurring; a single case
 * that still made the top three is rare but severe.
 */
function deriveSeverity(
  resolved: ReportEvaluatedCase[],
  ledgerSize: number,
): FixSeverity | null {
  const count = resolved.length;
  if (count === 0) return null;
  if (count === 1) return 'rare · severe';

  const categories = uniqueCategories(resolved).length;
  const share = ledgerSize > 0 ? count / ledgerSize : 0;
  if ((count >= 3 && categories >= 2) || share >= SYSTEMIC_LEDGER_SHARE) {
    return 'systemic';
  }
  return 'recurring';
}

const SEVERITY_CLASSES: Record<FixSeverity, string> = {
  systemic: 'border-red-200 bg-red-50 text-red-900',
  recurring: 'border-amber-200 bg-amber-50 text-amber-900',
  'rare · severe': 'border-slate-200 bg-slate-50 text-slate-700',
};

function TagChip({
  children,
  className = 'border-slate-200 bg-slate-50 text-slate-700',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-3xl border px-2.5 py-1 text-xs font-medium ${className}`}
    >
      {children}
    </span>
  );
}

/** One labelled body field. Prose is rendered verbatim, wrapped, and never clamped. */
function FixField({ label, value }: { label: string; value: string }) {
  const text = value.trim();
  return (
    <p className="text-sm leading-relaxed text-slate-700">
      <span className="font-semibold text-slate-900">{label} — </span>
      <span className="whitespace-pre-wrap">
        {text.length > 0 ? value : '(not stated)'}
      </span>
    </p>
  );
}

function EvidenceChips({ cited }: { cited: CitedCase[] }) {
  if (cited.length === 0) {
    return (
      <p className="text-xs text-slate-500">
        No case ids cited in this recommendation.
      </p>
    );
  }

  return (
    <ul className="flex flex-wrap gap-2">
      {cited.map((item) =>
        item.evaluated ? (
          <li key={item.key}>
            <a
              href={`#${caseAnchorId(item.evaluated.id)}`}
              className="inline-flex items-center gap-2 rounded-3xl border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <span className="font-mono break-all">{item.evaluated.id}</span>
              <span className="shrink-0 rounded-3xl bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">
                {item.evaluated.tier}
              </span>
            </a>
          </li>
        ) : (
          <li key={item.key}>
            <span className="inline-flex items-center gap-2 rounded-3xl border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs text-amber-900">
              <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
              <span className="font-mono break-all">{item.mention}</span>
              <span className="shrink-0 font-medium">unresolved</span>
            </span>
          </li>
        ),
      )}
    </ul>
  );
}

function FixCard({
  fix,
  perCase,
}: {
  fix: Top3Recommendation;
  perCase: ReportEvaluatedCase[];
}) {
  const cited = extractCitedCases(fix.evidence, perCase);
  const resolved = cited
    .map((item) => item.evaluated)
    .filter((item): item is ReportEvaluatedCase => item !== null);
  const unresolvedCount = cited.length - resolved.length;

  const severity = deriveSeverity(resolved, perCase.length);
  const tiers = uniqueTiers(resolved);
  const categories = uniqueCategories(resolved);

  return (
    <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <header className="flex items-start gap-4">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-3xl bg-slate-900 text-sm font-semibold text-white"
          aria-hidden="true"
        >
          {fix.priority}
        </span>
        <h3 className="text-base leading-relaxed font-semibold whitespace-pre-wrap text-slate-900">
          <span className="sr-only">{`Fix ${fix.priority}: `}</span>
          {fix.what}
        </h3>
      </header>

      <div className="mt-4 flex flex-wrap gap-2">
        {severity ? (
          <TagChip className={SEVERITY_CLASSES[severity]}>{severity}</TagChip>
        ) : null}
        <TagChip>
          {resolved.length === 1 ? '1 case cited' : `${resolved.length} cases cited`}
        </TagChip>
        {unresolvedCount > 0 ? (
          <TagChip className="border-amber-300 bg-amber-50 text-amber-900">
            <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
            {unresolvedCount === 1
              ? '1 unresolved id'
              : `${unresolvedCount} unresolved ids`}
          </TagChip>
        ) : null}
        {tiers.map((tier) => (
          <TagChip key={`tier-${tier}`} className="border-slate-200 bg-white text-slate-600">
            {tier}
          </TagChip>
        ))}
        {categories.map((category) => (
          <TagChip
            key={`category-${category}`}
            className="border-slate-200 bg-white text-slate-600"
          >
            {category}
          </TagChip>
        ))}
      </div>

      <div className="mt-4 space-y-3">
        <FixField label="Why first" value={fix.whyFirst} />
        <FixField label="Recommended change" value={fix.change} />
        <FixField label="Expected impact" value={fix.impact} />
        <FixField label="Affected" value={fix.affected} />
      </div>

      <div className="mt-5 border-t border-slate-100 pt-4">
        <h4 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
          Evidence
        </h4>
        <div className="mt-2">
          <EvidenceChips cited={cited} />
        </div>

        {/*
          Native <details> rather than React state: keyboard-operable for free, uncontrolled so the
          open state survives a re-render, and driven by the `[open]` attribute so B0-592's print
          CSS can force every disclosure open for the PDF export.
        */}
        <details
          className="group mt-3"
          data-report-disclosure="evidence"
          data-fix-priority={fix.priority}
        >
          <summary className="inline-flex cursor-pointer items-center rounded-3xl px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
            Evidence detail, as written
          </summary>
          <p className="mt-2 rounded-2xl bg-slate-50 p-3 text-sm leading-relaxed whitespace-pre-wrap text-slate-700">
            {fix.evidence.trim().length > 0 ? fix.evidence : '(not stated)'}
          </p>
        </details>
      </div>
    </article>
  );
}

/**
 * The report's top-3 action list. Both props are already-fetched slices — nothing is fetched here.
 *
 * `top3` is schema-guaranteed to hold exactly three entries, but this renders defensively over
 * whatever length actually arrives (partial or over-long synthesis output must not crash the page).
 */
export function ReportTopFixes({ synthesis, metrics }: ReportTopFixesProps) {
  const fixes = [...(synthesis.top3 ?? [])].sort(
    (a, b) => a.priority - b.priority,
  );
  const perCase = metrics.perCase ?? [];

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <h2 className="text-xl font-semibold text-slate-900">
        Fix these three things
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600">
        Ranked by how often the issue occurs, how severe each occurrence is, its business impact,
        its effect on Tier 1 cases and on the weakest categories, and whether it is systemic rather
        than isolated. Tier, category and case counts are derived from the cited case ids against
        the results ledger.
      </p>

      {fixes.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          This report&rsquo;s synthesis produced no prioritized fixes.
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          {fixes.map((fix, index) => (
            <FixCard key={`${fix.priority}-${index}`} fix={fix} perCase={perCase} />
          ))}
        </div>
      )}
    </section>
  );
}
