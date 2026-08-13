import type { CaseScore } from './schemas';

/**
 * Pure TS port of the manual "agent-evaluation" skill's `compute_metrics.py` (B0-453): every
 * number in the rendered report is derived here from raw case scores, never asked of the model,
 * so the executive scorecard and the case-by-case detail can never disagree.
 */

const WEIGHTS = {
  accuracy: 0.4,
  completeness: 0.3,
  relevance: 0.2,
  clarity: 0.1,
} as const;

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';
export type CaseStatus = 'Pass' | 'Partial Pass' | 'Fail';

export function gradeFromScore(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export function statusFromScore(score: number): CaseStatus {
  if (score >= 80) return 'Pass';
  if (score >= 60) return 'Partial Pass';
  return 'Fail';
}

/** Lower priority number = higher priority, matching the harness's existing UI tooltips. */
export function tierLabel(priority: number | null): string {
  return priority == null ? 'Unspecified' : `Tier ${priority}`;
}

function tierRank(label: string): number {
  const match = /tier\s*(\d+)/i.exec(label);
  return match ? Number(match[1]) : 99;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export type RateBlock = {
  n: number;
  avg: number | null;
  grade: Grade | '-';
  pass: number;
  partial: number;
  fail: number;
  passPct: number;
  partialPct: number;
  failPct: number;
};

function rateBlock(scores: number[]): RateBlock {
  const n = scores.length;
  if (n === 0) {
    return {
      n: 0,
      avg: null,
      grade: '-',
      pass: 0,
      partial: 0,
      fail: 0,
      passPct: 0,
      partialPct: 0,
      failPct: 0,
    };
  }
  const pass = scores.filter((s) => s >= 80).length;
  const partial = scores.filter((s) => s >= 60 && s < 80).length;
  const fail = scores.filter((s) => s < 60).length;
  const avg = round1(scores.reduce((a, b) => a + b, 0) / n);
  return {
    n,
    avg,
    grade: gradeFromScore(avg),
    pass,
    partial,
    fail,
    passPct: round1((100 * pass) / n),
    partialPct: round1((100 * partial) / n),
    failPct: round1((100 * fail) / n),
  };
}

export type LatencyBlock = {
  unit: 's';
  n: number;
  avg: number;
  min: number;
  max: number;
  median: number;
  thresholds: { good: number; slow: number };
  bands: { good: number; acceptable: number; slow: number };
  slowest: Array<{ id: string; seconds: number }>;
};

/** Responsiveness is reported alongside the grade but never blended into it (methodology §7). */
function latencyBlock(
  entries: Array<{ id: string; seconds: number }>,
  goodThreshold = 5,
  slowThreshold = 10,
): LatencyBlock | null {
  if (entries.length === 0) {
    return null;
  }
  const secs = entries.map((e) => e.seconds).sort((a, b) => a - b);
  const n = secs.length;
  const median =
    n % 2 === 1 ? secs[(n - 1) / 2] : round1((secs[n / 2 - 1] + secs[n / 2]) / 2);
  const good = secs.filter((s) => s <= goodThreshold).length;
  const slow = secs.filter((s) => s > slowThreshold).length;
  const acceptable = n - good - slow;
  const slowest = [...entries].sort((a, b) => b.seconds - a.seconds).slice(0, 3);
  return {
    unit: 's',
    n,
    avg: round1(secs.reduce((a, b) => a + b, 0) / n),
    min: secs[0],
    max: secs[n - 1],
    median,
    thresholds: { good: goodThreshold, slow: slowThreshold },
    bands: { good, acceptable, slow },
    slowest,
  };
}

export type ReportCaseInput = {
  testItemId: string;
  question: string;
  priorityRaw: number | null;
  category: string | null;
  score: CaseScore;
  latencySeconds: number | null;
};

export type EvaluatedCase = {
  id: string;
  question: string;
  tier: string;
  priorityRaw: number | null;
  category: string;
  accuracy: number;
  completeness: number;
  relevance: number;
  clarity: number;
  overall: number;
  grade: Grade;
  status: CaseStatus;
};

export type UteCase = {
  id: string;
  question: string;
  reason: string;
};

export type ReportMetrics = {
  totalCases: number;
  evaluated: number;
  ute: UteCase[];
  uteCount: number;
  overall: RateBlock;
  highest: Array<{ id: string; question: string; overall: number }>;
  lowest: Array<{ id: string; question: string; overall: number }>;
  perCase: EvaluatedCase[];
  tiers: Array<[string, RateBlock]>;
  categories: Array<[string, RateBlock]>;
  strongestCategory: string | null;
  weakestCategory: string | null;
  latency: LatencyBlock | null;
  warnings: string[];
};

function groupBy(
  cases: EvaluatedCase[],
  keyFn: (c: EvaluatedCase) => string,
  sortFn?: (a: string, b: string) => number,
): Array<[string, RateBlock]> {
  const order: string[] = [];
  const groups = new Map<string, number[]>();
  for (const c of cases) {
    const key = keyFn(c);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(c.overall);
  }
  const keys = sortFn ? [...order].sort(sortFn) : order;
  return keys.map((key) => [key, rateBlock(groups.get(key)!)]);
}

export function computeReportMetrics(inputs: ReportCaseInput[]): ReportMetrics {
  const total = inputs.length;
  const ute: UteCase[] = [];
  const evaluated: EvaluatedCase[] = [];
  const warnings: string[] = [];
  const latencyEntries: Array<{ id: string; seconds: number }> = [];

  for (const input of inputs) {
    if (input.latencySeconds != null) {
      latencyEntries.push({ id: input.testItemId, seconds: input.latencySeconds });
    }

    if (input.score.unableToEvaluate) {
      ute.push({
        id: input.testItemId,
        question: input.question,
        reason: input.score.uteReason ?? 'unspecified',
      });
      continue;
    }

    const rawSubs = {
      accuracy: input.score.accuracy,
      completeness: input.score.completeness,
      relevance: input.score.relevance,
      clarity: input.score.clarity,
    };
    const missing = Object.entries(rawSubs).filter(([, v]) => v == null);
    if (missing.length > 0) {
      warnings.push(
        `${input.testItemId}: missing sub-score(s) ${missing.map(([k]) => k).join(', ')}`,
      );
    }
    const accuracy = rawSubs.accuracy ?? 0;
    const completeness = rawSubs.completeness ?? 0;
    const relevance = rawSubs.relevance ?? 0;
    const clarity = rawSubs.clarity ?? 0;
    const overall = Math.round(
      WEIGHTS.accuracy * accuracy +
        WEIGHTS.completeness * completeness +
        WEIGHTS.relevance * relevance +
        WEIGHTS.clarity * clarity,
    );

    evaluated.push({
      id: input.testItemId,
      question: input.question,
      tier: tierLabel(input.priorityRaw),
      priorityRaw: input.priorityRaw,
      category: input.category?.trim() || 'Uncategorized',
      accuracy,
      completeness,
      relevance,
      clarity,
      overall,
      grade: gradeFromScore(overall),
      status: statusFromScore(overall),
    });
  }

  const scores = evaluated.map((e) => e.overall);
  const overall = rateBlock(scores);

  let highest: ReportMetrics['highest'] = [];
  let lowest: ReportMetrics['lowest'] = [];
  if (scores.length > 0) {
    const max = Math.max(...scores);
    const min = Math.min(...scores);
    highest = evaluated
      .filter((e) => e.overall === max)
      .map((e) => ({ id: e.id, question: e.question, overall: e.overall }));
    lowest = evaluated
      .filter((e) => e.overall === min)
      .map((e) => ({ id: e.id, question: e.question, overall: e.overall }));
  }

  const tiers = groupBy(evaluated, (e) => e.tier, (a, b) => tierRank(a) - tierRank(b));
  const categories = groupBy(evaluated, (e) => e.category);

  let strongestCategory: string | null = null;
  let weakestCategory: string | null = null;
  let strongestAvg = -Infinity;
  let weakestAvg = Infinity;
  for (const [name, block] of categories) {
    if (block.avg == null) continue;
    if (block.avg > strongestAvg) {
      strongestAvg = block.avg;
      strongestCategory = name;
    }
    if (block.avg < weakestAvg) {
      weakestAvg = block.avg;
      weakestCategory = name;
    }
  }

  const latency = latencyBlock(latencyEntries);

  // Reconciliation checks (methodology §11) — surfaced as warnings, never thrown: a mismatch
  // here means bad input data, not a reason to fail report generation.
  if (overall.pass + overall.partial + overall.fail !== evaluated.length) {
    warnings.push('RECONCILE: pass+partial+fail != evaluated');
  }
  if (evaluated.length !== total - ute.length) {
    warnings.push('RECONCILE: evaluated != total - UTE');
  }
  if (tiers.reduce((sum, [, b]) => sum + b.n, 0) !== evaluated.length) {
    warnings.push('RECONCILE: tier case counts do not sum to evaluated');
  }
  if (categories.reduce((sum, [, b]) => sum + b.n, 0) !== evaluated.length) {
    warnings.push('RECONCILE: category case counts do not sum to evaluated');
  }
  if (warnings.length > 0) {
    console.warn('[report-metrics]', warnings.join('; '));
  }

  return {
    totalCases: total,
    evaluated: evaluated.length,
    ute,
    uteCount: ute.length,
    overall,
    highest,
    lowest,
    perCase: evaluated,
    tiers,
    categories,
    strongestCategory,
    weakestCategory,
    latency,
    warnings,
  };
}
