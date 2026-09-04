import { z } from 'zod';

import { normConcept, type CaseConcepts } from './case-concepts';
import {
  completenessFromCoverage,
  computeOverall,
  gradeFromScore,
  NO_EXPECTED_CONCEPTS_UTE_REASON,
  round1,
  round2,
  statusFromScore,
  type CaseStatus,
  type Grade,
} from './metrics';
import { DEFAULT_JUDGED_THRESHOLDS, DEFAULT_PASS_MARK } from './scoring-config';

/**
 * B0-824 — judgment-variance study: Bex's run-report grader vs the desktop agent-evaluation flow
 * on the SAME run, from two consolidated `eval.json` files in the skill's schema
 * (`~/.claude/skills/agent-evaluation/references/eval_schema.json`).
 *
 * Bex is the spec. Each side's `overall` and Result are recomputed HERE the Bex way from the judged
 * sub-scores and the per-concept verdicts — `completenessFromCoverage` → `computeOverall` →
 * `statusFromScore` — and every derived number a file may carry (a judged `completeness`, a
 * weighted score, a grade, a status) is ignored. What is being compared is therefore judgment
 * alone: the three judged sub-scores and which concepts each grader found. A side with no expected
 * concepts for a case is Unable to Evaluate, exactly as in `metrics.ts`.
 *
 * Concept phrases are regulated free text: they are compared by `normConcept` identity key only
 * and never parsed, re-cased or displayed from here.
 *
 * Pure functions, no I/O. The CLI (`scripts/compare-eval-runs.ts`) reads the two files and prints
 * `renderParityMarkdown`.
 */

/** |Δ overall| at or above which a case pair must be explained by a recorded concept disagreement. */
export const DEFAULT_SPREAD_THRESHOLD = 10;

/** The ticket's proposed acceptance targets — not yet confirmed by Tom; reported as such. */
export const PROPOSED_TARGETS = {
  medianDeltaMax: 5,
  statusAgreementMinPct: 90,
} as const;

export const PROPOSED_TARGET_NOTE = 'proposed — confirm with Tom';

const conceptListSchema = z.array(z.string()).optional();
const scoreSchema = z.number().min(0).max(100).nullable().optional();

/**
 * The subset of one `cases[]` entry this comparison reads. Loose on purpose: the skill's file also
 * carries narrative fields, timings and (on the desktop side) derived numbers, all of which pass
 * through unread.
 */
export const evalCaseSchema = z.looseObject({
  id: z.string().min(1),
  question: z.string().nullable().optional(),
  tier: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  accuracy: scoreSchema,
  completeness: scoreSchema,
  relevance: scoreSchema,
  clarity: scoreSchema,
  concepts: z
    .looseObject({
      minimal_required: conceptListSchema,
      minimal_satisfied: conceptListSchema,
      minimal_missing: conceptListSchema,
      expected_required: conceptListSchema,
      expected_satisfied: conceptListSchema,
      expected_missing: conceptListSchema,
      material_issue: z.boolean().nullable().optional(),
    })
    .nullable()
    .optional(),
  unable_to_evaluate: z.boolean().nullable().optional(),
  ute_reason: z.string().nullable().optional(),
  eval_confidence: scoreSchema,
});

export const evalFileSchema = z.looseObject({
  meta: z
    .looseObject({
      workbook: z.string().nullable().optional(),
      run_url: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  cases: z.array(evalCaseSchema),
});

export type EvalCase = z.infer<typeof evalCaseSchema>;
export type EvalFile = z.infer<typeof evalFileSchema>;

export type ParseEvalFileResult = { ok: true; data: EvalFile } | { ok: false; issues: string[] };

/** Boundary parse of a decoded JSON document (`safeParse`; issues are rendered `path: message`). */
export function parseEvalFile(input: unknown): ParseEvalFileResult {
  const parsed = evalFileSchema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
    ),
  };
}

/** One kind's verdicts as `normConcept` identity keys — for set equality only, never displayed. */
export type ConceptVerdicts = {
  satisfied: ReadonlySet<string>;
  missing: ReadonlySet<string>;
};

export type SideEvaluation = {
  id: string;
  question: string;
  tier: string;
  category: string;
  unableToEvaluate: boolean;
  uteReason: string | null;
  accuracy: number | null;
  /** Computed from expected-concept coverage; a judged value in the file is never read. */
  completeness: number | null;
  relevance: number | null;
  clarity: number | null;
  overall: number | null;
  status: CaseStatus | null;
  /** `null` when the side recorded no concepts block for the case. */
  mandatory: ConceptVerdicts | null;
  expected: ConceptVerdicts | null;
  materialIssue: boolean | null;
  evalConfidence: number | null;
  inReviewQueue: boolean;
};

export type SideOptions = { passMark: number; reviewThreshold: number };

const UNSPECIFIED = 'Unspecified';

function toKeySet(phrases: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const phrase of phrases) {
    const key = normConcept(phrase);
    if (key) keys.add(key);
  }
  return keys;
}

function setEquals(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a) {
    if (!b.has(key)) return false;
  }
  return true;
}

function verdictsEqual(a: ConceptVerdicts, b: ConceptVerdicts): boolean {
  return setEquals(a.satisfied, b.satisfied) && setEquals(a.missing, b.missing);
}

/** `required` is authored in the file; when absent it is satisfied ∪ missing, in that order. */
function coverageOf(
  required: readonly string[] | undefined,
  satisfied: readonly string[] | undefined,
  missing: readonly string[] | undefined,
) {
  const sat = [...(satisfied ?? [])];
  const mis = [...(missing ?? [])];
  return { required: required ? [...required] : [...sat, ...mis], satisfied: sat, missing: mis };
}

function conceptsOf(block: EvalCase['concepts']): CaseConcepts | null {
  if (!block) return null;
  return {
    mandatory: coverageOf(block.minimal_required, block.minimal_satisfied, block.minimal_missing),
    expected: coverageOf(block.expected_required, block.expected_satisfied, block.expected_missing),
    materialIssue: block.material_issue ?? false,
    materialIssueNote: null,
  };
}

function label(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : UNSPECIFIED;
}

/** Scores one side of one case the Bex way. */
export function evaluateSide(c: EvalCase, options: SideOptions): SideEvaluation {
  const concepts = conceptsOf(c.concepts);
  const evalConfidence = c.eval_confidence ?? null;
  const base = {
    id: c.id,
    question: c.question ?? '',
    tier: label(c.tier),
    category: label(c.category),
    mandatory: concepts
      ? { satisfied: toKeySet(concepts.mandatory.satisfied), missing: toKeySet(concepts.mandatory.missing) }
      : null,
    expected: concepts
      ? { satisfied: toKeySet(concepts.expected.satisfied), missing: toKeySet(concepts.expected.missing) }
      : null,
    materialIssue: c.concepts?.material_issue ?? null,
    evalConfidence,
  };
  const ute = (reason: string): SideEvaluation => ({
    ...base,
    unableToEvaluate: true,
    uteReason: reason,
    accuracy: null,
    completeness: null,
    relevance: null,
    clarity: null,
    overall: null,
    status: null,
    inReviewQueue: false,
  });

  if (c.unable_to_evaluate) {
    return ute(c.ute_reason?.trim() || 'Marked Unable to Evaluate in the file.');
  }
  const accuracy = c.accuracy ?? null;
  const relevance = c.relevance ?? null;
  const clarity = c.clarity ?? null;
  if (accuracy == null || relevance == null || clarity == null) {
    return ute('Missing a judged sub-score (accuracy, relevance or clarity).');
  }
  const completeness = completenessFromCoverage(concepts);
  if (completeness == null) return ute(NO_EXPECTED_CONCEPTS_UTE_REASON);

  const overall = computeOverall({ accuracy, completeness, relevance, clarity });
  return {
    ...base,
    unableToEvaluate: false,
    uteReason: null,
    accuracy,
    completeness,
    relevance,
    clarity,
    overall,
    status: statusFromScore(overall, options.passMark),
    // Bex's SME review queue is "at or below" the low-confidence threshold (metrics.ts), not below.
    inReviewQueue: evalConfidence != null && evalConfidence <= options.reviewThreshold,
  };
}

export type CaseComparison = {
  id: string;
  question: string;
  tier: string;
  category: string;
  a: SideEvaluation;
  b: SideEvaluation;
  /** Both sides evaluable — the only rows the rollups count. */
  compared: boolean;
  /** |overall A − overall B|, or null unless compared. */
  delta: number | null;
  statusAgree: boolean | null;
  /** Set equality of the normalised mandatory `satisfied` AND `missing` lists; null if a side has no block. */
  mandatoryAgree: boolean | null;
  expectedAgree: boolean | null;
  materialIssueAgree: boolean | null;
  /** Either concept kind's verdicts differ. */
  conceptDisagreement: boolean;
  reviewA: boolean;
  reviewB: boolean;
  reviewOverlap: boolean;
  /** `delta` at or above the spread threshold. */
  spread: boolean;
  /** For a spread case: whether a recorded concept disagreement accounts for it. */
  spreadExplained: boolean | null;
};

function compareCase(a: SideEvaluation, b: SideEvaluation, spreadThreshold: number): CaseComparison {
  const compared = !a.unableToEvaluate && !b.unableToEvaluate;
  const delta = a.overall != null && b.overall != null ? Math.abs(a.overall - b.overall) : null;
  const statusAgree = a.status != null && b.status != null ? a.status === b.status : null;
  const mandatoryAgree = a.mandatory && b.mandatory ? verdictsEqual(a.mandatory, b.mandatory) : null;
  const expectedAgree = a.expected && b.expected ? verdictsEqual(a.expected, b.expected) : null;
  const materialIssueAgree =
    a.materialIssue != null && b.materialIssue != null ? a.materialIssue === b.materialIssue : null;
  const conceptDisagreement = mandatoryAgree === false || expectedAgree === false;
  const spread = delta != null && delta >= spreadThreshold;
  return {
    id: a.id,
    question: a.question || b.question,
    tier: a.tier !== UNSPECIFIED ? a.tier : b.tier,
    category: a.category !== UNSPECIFIED ? a.category : b.category,
    a,
    b,
    compared,
    delta,
    statusAgree,
    mandatoryAgree,
    expectedAgree,
    materialIssueAgree,
    conceptDisagreement,
    reviewA: a.inReviewQueue,
    reviewB: b.inReviewQueue,
    reviewOverlap: a.inReviewQueue && b.inReviewQueue,
    spread,
    spreadExplained: spread ? conceptDisagreement : null,
  };
}

export type SideRollup = {
  n: number;
  avg: number | null;
  grade: Grade | '-';
  pass: number;
  passPct: number | null;
};

export type GroupRow = {
  key: string;
  n: number;
  avgA: number | null;
  avgB: number | null;
  agree: number;
  agreementPct: number | null;
};

export type SpreadCase = { id: string; overallA: number; overallB: number; delta: number; explained: boolean };

export type TargetCheck = {
  name: string;
  target: string;
  actual: string;
  met: boolean | null;
  note: typeof PROPOSED_TARGET_NOTE;
};

export type ParityRollup = {
  passMark: number;
  spreadThreshold: number;
  reviewThreshold: number;
  /** Ids present in both files. */
  matched: number;
  unmatchedA: string[];
  unmatchedB: string[];
  /** Matched cases both sides could evaluate — the basis of every number below. */
  compared: number;
  uteEither: number;
  medianDelta: number | null;
  meanDelta: number | null;
  statusAgreement: { agree: number; of: number; pct: number | null };
  spreadCases: SpreadCase[];
  sideA: SideRollup;
  sideB: SideRollup;
  tiers: GroupRow[];
  categories: GroupRow[];
  reviewQueue: { a: string[]; b: string[]; overlap: string[]; union: number; jaccard: number | null };
  targets: TargetCheck[];
};

export type ParityComparison = {
  labels: { a: string; b: string };
  cases: CaseComparison[];
  rollup: ParityRollup;
};

export type CompareOptions = {
  passMark?: number;
  spreadThreshold?: number;
  reviewThreshold?: number;
  labelA?: string;
  labelB?: string;
};

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : round1(values.reduce((sum, v) => sum + v, 0) / values.length);
}

/** Median with the metrics.ts convention: middle value, or the half-up one-decimal mean of the two. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const n = sorted.length;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : round1((sorted[n / 2 - 1] + sorted[n / 2]) / 2);
}

function pct(part: number, whole: number): number | null {
  return whole === 0 ? null : round1((100 * part) / whole);
}

function sideRollup(sides: readonly SideEvaluation[]): SideRollup {
  const overalls = sides.flatMap((s) => (s.overall == null ? [] : [s.overall]));
  const avg = mean(overalls);
  const pass = sides.filter((s) => s.status === 'Pass').length;
  return { n: sides.length, avg, grade: avg == null ? '-' : gradeFromScore(avg), pass, passPct: pct(pass, sides.length) };
}

function groupRows(cases: readonly CaseComparison[], keyOf: (c: CaseComparison) => string): GroupRow[] {
  const groups = new Map<string, CaseComparison[]>();
  for (const c of cases) {
    const key = keyOf(c);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.entries()]
    .sort(([x], [y]) => x.localeCompare(y, 'en', { numeric: true }))
    .map(([key, group]) => {
      const agree = group.filter((c) => c.statusAgree === true).length;
      return {
        key,
        n: group.length,
        avgA: mean(group.flatMap((c) => (c.a.overall == null ? [] : [c.a.overall]))),
        avgB: mean(group.flatMap((c) => (c.b.overall == null ? [] : [c.b.overall]))),
        agree,
        agreementPct: pct(agree, group.length),
      };
    });
}

/** Pairs cases by `id` and computes every per-case row and rollup. */
export function compareEvalRuns(a: EvalFile, b: EvalFile, options: CompareOptions = {}): ParityComparison {
  const passMark = options.passMark ?? DEFAULT_PASS_MARK;
  const spreadThreshold = options.spreadThreshold ?? DEFAULT_SPREAD_THRESHOLD;
  const reviewThreshold = options.reviewThreshold ?? DEFAULT_JUDGED_THRESHOLDS.lowConfidence;
  const sideOptions: SideOptions = { passMark, reviewThreshold };

  const byIdB = new Map(b.cases.map((c) => [c.id, c] as const));
  const idsA = new Set(a.cases.map((c) => c.id));
  const cases: CaseComparison[] = [];
  const unmatchedA: string[] = [];
  for (const ca of a.cases) {
    const cb = byIdB.get(ca.id);
    if (!cb) {
      unmatchedA.push(ca.id);
      continue;
    }
    cases.push(compareCase(evaluateSide(ca, sideOptions), evaluateSide(cb, sideOptions), spreadThreshold));
  }
  const unmatchedB = b.cases.filter((c) => !idsA.has(c.id)).map((c) => c.id);

  const compared = cases.filter((c) => c.compared);
  const deltas = compared.flatMap((c) => (c.delta == null ? [] : [c.delta]));
  const agree = compared.filter((c) => c.statusAgree === true).length;
  const statusAgreement = { agree, of: compared.length, pct: pct(agree, compared.length) };
  const spreadCases: SpreadCase[] = compared.flatMap((c) =>
    c.spread && c.delta != null && c.a.overall != null && c.b.overall != null
      ? [{ id: c.id, overallA: c.a.overall, overallB: c.b.overall, delta: c.delta, explained: c.conceptDisagreement }]
      : [],
  );
  const explained = spreadCases.filter((s) => s.explained).length;

  const reviewA = compared.filter((c) => c.reviewA).map((c) => c.id);
  const reviewB = compared.filter((c) => c.reviewB).map((c) => c.id);
  const overlap = compared.filter((c) => c.reviewOverlap).map((c) => c.id);
  const union = new Set([...reviewA, ...reviewB]).size;
  const jaccard = union === 0 ? null : round2(overlap.length / union);

  const medianDelta = median(deltas);
  const meanDelta = mean(deltas);

  const targets: TargetCheck[] = [
    {
      name: 'Median |Δ overall|',
      target: `≤ ${PROPOSED_TARGETS.medianDeltaMax}`,
      actual: medianDelta == null ? 'n/a' : String(medianDelta),
      met: medianDelta == null ? null : medianDelta <= PROPOSED_TARGETS.medianDeltaMax,
      note: PROPOSED_TARGET_NOTE,
    },
    {
      name: 'Pass/Fail agreement',
      target: `≥ ${PROPOSED_TARGETS.statusAgreementMinPct}%`,
      actual: statusAgreement.pct == null ? 'n/a' : `${statusAgreement.pct}% (${agree}/${compared.length})`,
      met: statusAgreement.pct == null ? null : statusAgreement.pct >= PROPOSED_TARGETS.statusAgreementMinPct,
      note: PROPOSED_TARGET_NOTE,
    },
    {
      name: `Every case with |Δ| ≥ ${spreadThreshold} explained by a recorded concept disagreement`,
      target: 'all',
      actual: `${explained}/${spreadCases.length}`,
      met: explained === spreadCases.length,
      note: PROPOSED_TARGET_NOTE,
    },
  ];

  return {
    labels: { a: options.labelA ?? 'Bex', b: options.labelB ?? 'Desktop' },
    cases,
    rollup: {
      passMark,
      spreadThreshold,
      reviewThreshold,
      matched: cases.length,
      unmatchedA,
      unmatchedB,
      compared: compared.length,
      uteEither: cases.length - compared.length,
      medianDelta,
      meanDelta,
      statusAgreement,
      spreadCases,
      sideA: sideRollup(compared.map((c) => c.a)),
      sideB: sideRollup(compared.map((c) => c.b)),
      tiers: groupRows(compared, (c) => c.tier),
      categories: groupRows(compared, (c) => c.category),
      reviewQueue: { a: reviewA, b: reviewB, overlap, union, jaccard },
      targets,
    },
  };
}

// ---- Markdown rendering ------------------------------------------------------------------------

const QUESTION_MAX = 70;

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function mdTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => `| ${cells.map(cell).join(' | ')} |`;
  return [line(headers), `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(line)].join('\n');
}

const num = (value: number | null | undefined): string => (value == null ? '—' : String(value));
const yn = (value: boolean | null | undefined): string => (value == null ? 'n/a' : value ? 'yes' : 'no');
const list = (ids: readonly string[]): string => (ids.length === 0 ? 'none' : ids.join(', '));

function sideCell(side: SideEvaluation): string {
  return side.unableToEvaluate ? 'UTE' : `${num(side.overall)} ${side.status ?? ''}`.trim();
}

/** The whole study as one Markdown document: rollups, targets, spread cases, tables, per-case rows. */
export function renderParityMarkdown(result: ParityComparison): string {
  const { labels, rollup: r, cases } = result;
  const out: string[] = [];

  out.push(`# Grading parity — ${labels.a} vs ${labels.b} (B0-824)`, '');
  out.push(
    `Both sides are re-scored the Bex way from their judged sub-scores and concept verdicts: ` +
      `Completeness = 100 × expected satisfied / required; overall = 0.40·A + 0.30·C + 0.20·R + 0.10·Cl (half-up); ` +
      `Pass at ≥ ${r.passMark}. Any derived number carried in either file is ignored. ` +
      `Δ is |overall ${labels.a} − overall ${labels.b}|; spread = Δ ≥ ${r.spreadThreshold}; ` +
      `review queue = eval_confidence ≤ ${r.reviewThreshold}. ` +
      `Rollups are over the ${r.compared} matched cases both sides could evaluate (like-for-like), so they will not equal either side's own report.`,
    '',
  );

  out.push('## Rollups', '');
  out.push(
    mdTable(
      ['Metric', 'Value'],
      [
        ['Cases matched by id', String(r.matched)],
        [`Only in ${labels.a}`, list(r.unmatchedA)],
        [`Only in ${labels.b}`, list(r.unmatchedB)],
        ['Compared (both evaluable)', String(r.compared)],
        ['Unable to Evaluate on either side', String(r.uteEither)],
        ['Median Δ', num(r.medianDelta)],
        ['Mean Δ', num(r.meanDelta)],
        [
          'Pass/Fail agreement',
          r.statusAgreement.pct == null
            ? '—'
            : `${r.statusAgreement.agree}/${r.statusAgreement.of} (${r.statusAgreement.pct}%)`,
        ],
        [
          `Cases with Δ ≥ ${r.spreadThreshold}`,
          `${r.spreadCases.length} (${r.spreadCases.filter((s) => s.explained).length} explained by a concept disagreement)`,
        ],
        [
          'Review-queue overlap (Jaccard)',
          r.reviewQueue.jaccard == null ? '— (neither side queued a case)' : `${r.reviewQueue.overlap.length} of ${r.reviewQueue.union} (${r.reviewQueue.jaccard})`,
        ],
      ],
    ),
    '',
  );

  out.push(
    mdTable(
      ['', labels.a, labels.b],
      [
        ['Overall avg', num(r.sideA.avg), num(r.sideB.avg)],
        ['Grade', r.sideA.grade, r.sideB.grade],
        [
          'Pass rate',
          `${r.sideA.pass}/${r.sideA.n} (${num(r.sideA.passPct)}%)`,
          `${r.sideB.pass}/${r.sideB.n} (${num(r.sideB.passPct)}%)`,
        ],
        ['Review queue', list(r.reviewQueue.a), list(r.reviewQueue.b)],
      ],
    ),
    '',
  );

  out.push(`## Targets (${PROPOSED_TARGET_NOTE})`, '');
  out.push(
    mdTable(
      ['Target', 'Threshold', 'Actual', 'Met', 'Status'],
      r.targets.map((t) => [t.name, t.target, t.actual, yn(t.met), t.note]),
    ),
    '',
  );

  out.push(`## Cases with Δ ≥ ${r.spreadThreshold}`, '');
  out.push(
    r.spreadCases.length === 0
      ? 'None.'
      : mdTable(
          ['Case', labels.a, labels.b, 'Δ', 'Explained by concept disagreement'],
          r.spreadCases.map((s) => [s.id, String(s.overallA), String(s.overallB), String(s.delta), yn(s.explained)]),
        ),
    '',
  );

  const groupTable = (title: string, rows: readonly GroupRow[]) => {
    out.push(`## By ${title}`, '');
    out.push(
      rows.length === 0
        ? 'No compared cases.'
        : mdTable(
            [title, 'n', `Avg ${labels.a}`, `Avg ${labels.b}`, 'Pass/Fail agreement'],
            rows.map((g) => [g.key, String(g.n), num(g.avgA), num(g.avgB), `${g.agree}/${g.n} (${num(g.agreementPct)}%)`]),
          ),
      '',
    );
  };
  groupTable('Tier', r.tiers);
  groupTable('Category', r.categories);

  const utes = cases.filter((c) => !c.compared);
  if (utes.length > 0) {
    out.push('## Unable to Evaluate', '');
    out.push(
      mdTable(
        ['Case', 'Side', 'Reason'],
        utes.flatMap((c) =>
          [
            c.a.unableToEvaluate ? [c.id, labels.a, truncate(c.a.uteReason ?? '', 120)] : null,
            c.b.unableToEvaluate ? [c.id, labels.b, truncate(c.b.uteReason ?? '', 120)] : null,
          ].filter((row): row is string[] => row != null),
        ),
      ),
      '',
    );
  }

  out.push('## Per case', '');
  out.push(
    mdTable(
      [
        'Case',
        'Question',
        labels.a,
        labels.b,
        'Δ',
        'Result agrees',
        'Mandatory verdicts agree',
        'Expected verdicts agree',
        'Material issue agrees',
        `Review ${labels.a}`,
        `Review ${labels.b}`,
        'Concept disagreement',
      ],
      cases.map((c) => [
        c.id,
        truncate(c.question, QUESTION_MAX),
        sideCell(c.a),
        sideCell(c.b),
        num(c.delta),
        yn(c.statusAgree),
        yn(c.mandatoryAgree),
        yn(c.expectedAgree),
        yn(c.materialIssueAgree),
        yn(c.reviewA),
        yn(c.reviewB),
        yn(c.conceptDisagreement),
      ]),
    ),
    '',
  );

  return out.join('\n');
}
