import { z } from 'zod';

import { normConcept, type CaseConcepts } from './case-concepts';
import { gradeFromScore, NO_EXPECTED_CONCEPTS_UTE_REASON, round1, round2, type CaseStatus, type Grade } from './metrics';
import {
  DEFAULT_JUDGED_THRESHOLDS,
  DEFAULT_PASS_MARK,
  DEFAULT_SCORING_RULES,
  sanitizeScoringRules,
  type ScoringRules,
} from './scoring-config';
import { deriveCaseScoreline, type StatusSource } from './scoring-rules';

/**
 * B0-824 / B0-835 — judgment-variance study: Bex's run-report grader vs the desktop
 * agent-evaluation flow on the SAME run, from two consolidated `eval.json` files in the skill's
 * schema (`~/.claude/skills/agent-evaluation/references/eval_schema.json`).
 *
 * Bex is the spec. Each side's `overall` and Result are recomputed HERE, through the one shared
 * pipeline `deriveCaseScoreline` (`./scoring-rules`) — coverage cap on Completeness → weight →
 * mandatory floor → Pre-Gate Content Score → mandatory ceiling → round → Result (rubric, then the
 * automatic Pass, then the mandatory gate). A file's judged `completeness` IS read, because it is
 * an input to the pipeline (Rule 3 caps it at coverage); a missing one means coverage is the only
 * Completeness that side has. Every *derived* number a file may carry (a weighted score, a grade,
 * a status, a pre-gate score) is still ignored. What is being compared is therefore judgment
 * alone: the four judged sub-scores and which concepts each grader found. A side with no expected
 * concepts for a case is Unable to Evaluate, exactly as in `metrics.ts`.
 *
 * **Both sides are always recomputed under ONE set of rules** — a comparison run under two
 * different rule sets measures the rules, not the judgment, so it is refused rather than reported.
 * The rules come from either file's `scoring_config` block (`applyScoringOverrides`, the port of
 * the reference `concept_rules.apply_scoring_overrides`) and default to `DEFAULT_SCORING_RULES`;
 * two files that declare *different* blocks make `compareEvalRuns` throw, naming both.
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
  /** The grader's judged Completeness — an INPUT to the scoring pipeline (B0-835), not a derived value. */
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
  /**
   * The run's `scoring_config`, read by `applyScoringOverrides`. Deliberately `unknown`: the
   * reference `apply_scoring_overrides` *warns* on a malformed block and keeps the defaults, so a
   * bad one must not fail the whole file's parse.
   */
  scoring_config: z.unknown().optional(),
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

// ---- scoring_config -----------------------------------------------------------------------------

/**
 * The recognised `scoring_config` sections and their keys, mirroring the reference
 * `concept_rules.SCORING_DEFAULTS`. Anything else is ignored with a warning, never honoured.
 */
export const SCORING_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = {
  pass_mark: ['score'],
  minimal_gate: ['enabled'],
  minimal_floor: ['enabled', 'score', 'respect_material_issue'],
  minimal_ceiling: ['enabled', 'score'],
  expected_coverage: ['enabled'],
};

/** What one file's `scoring_config` resolved to, plus every complaint made along the way. */
export type ScoringConfigResolution = {
  rules: ScoringRules;
  passMark: number;
  /** True when the file declared a `scoring_config` block at all (even an empty one). */
  declared: boolean;
  /** True only when that block set a valid `pass_mark.score`. */
  passMarkDeclared: boolean;
  warnings: string[];
};

function describeType(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

function inspect(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

function isScoreValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/**
 * Port of the reference `concept_rules.apply_scoring_overrides`: an eval.json `scoring_config`
 * object laid over `DEFAULT_SCORING_RULES` + `DEFAULT_PASS_MARK`, key by key. Recognised shape —
 *
 *     {"pass_mark":         {"score": 60},
 *      "minimal_gate":      {"enabled": true},
 *      "minimal_floor":     {"enabled": true, "score": 70, "respect_material_issue": true},
 *      "minimal_ceiling":   {"enabled": true, "score": 59},
 *      "expected_coverage": {"enabled": true}}
 *
 * — and, as in the reference, an unknown key, a non-object section or an out-of-range score is
 * **ignored with a warning** rather than silently honoured or fatal, so one typo cannot quietly
 * disable a safety rule. The result goes through `sanitizeScoringRules` for the same reason the
 * settings path does.
 */
export function applyScoringOverrides(cfg: unknown, label = 'scoring config'): ScoringConfigResolution {
  const warnings: string[] = [];
  const draft: ScoringRules = {
    minimalGate: { ...DEFAULT_SCORING_RULES.minimalGate },
    minimalFloor: { ...DEFAULT_SCORING_RULES.minimalFloor },
    minimalCeiling: { ...DEFAULT_SCORING_RULES.minimalCeiling },
    expectedCoverage: { ...DEFAULT_SCORING_RULES.expectedCoverage },
  };
  let passMark = DEFAULT_PASS_MARK;
  let passMarkDeclared = false;

  const done = (declared: boolean): ScoringConfigResolution => ({
    rules: sanitizeScoringRules(draft),
    passMark,
    declared,
    passMarkDeclared,
    warnings,
  });

  if (cfg == null) return done(false);
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    warnings.push(`${label}: expected an object, got ${describeType(cfg)}; ignored`);
    return done(false);
  }

  const bool = (section: string, key: string, value: unknown, current: boolean): boolean => {
    if (typeof value === 'boolean') return value;
    warnings.push(
      `${label}: ${section}.${key} must be true or false (got ${inspect(value)}); kept ${current}`,
    );
    return current;
  };
  const score = (section: string, value: unknown, current: number): number => {
    if (isScoreValue(value)) return value;
    warnings.push(
      `${label}: ${section}.score must be a number 0-100 (got ${inspect(value)}); kept ${current}`,
    );
    return current;
  };

  for (const [section, keys] of Object.entries(SCORING_CONFIG_KEYS)) {
    const sub = (cfg as Record<string, unknown>)[section];
    if (sub == null) continue;
    if (typeof sub !== 'object' || Array.isArray(sub)) {
      warnings.push(`${label}: '${section}' expected an object, got ${describeType(sub)}; ignored`);
      continue;
    }
    for (const [key, value] of Object.entries(sub as Record<string, unknown>)) {
      if (!keys.includes(key)) {
        warnings.push(
          `${label}: unknown key '${section}.${key}' ignored (known: ${[...keys].sort().join(', ')})`,
        );
        continue;
      }
      if (section === 'pass_mark') {
        const next = score('pass_mark', value, passMark);
        if (isScoreValue(value)) passMarkDeclared = true;
        passMark = next;
      } else if (section === 'minimal_gate') {
        draft.minimalGate.enabled = bool(section, key, value, draft.minimalGate.enabled);
      } else if (section === 'minimal_floor') {
        if (key === 'score') draft.minimalFloor.score = score(section, value, draft.minimalFloor.score);
        else if (key === 'enabled') draft.minimalFloor.enabled = bool(section, key, value, draft.minimalFloor.enabled);
        else {
          draft.minimalFloor.respectMaterialIssue = bool(
            section,
            key,
            value,
            draft.minimalFloor.respectMaterialIssue,
          );
        }
      } else if (section === 'minimal_ceiling') {
        if (key === 'score') draft.minimalCeiling.score = score(section, value, draft.minimalCeiling.score);
        else draft.minimalCeiling.enabled = bool(section, key, value, draft.minimalCeiling.enabled);
      } else {
        draft.expectedCoverage.enabled = bool(section, key, value, draft.expectedCoverage.enabled);
      }
    }
  }

  return done(true);
}

/** One line naming every rule in force, for the mismatch error and the report's method paragraph. */
export function describeScoringRules(rules: ScoringRules, passMark: number): string {
  const floor = rules.minimalFloor.enabled
    ? `floor on at ${rules.minimalFloor.score}${rules.minimalFloor.respectMaterialIssue ? ' (withheld on a material factual issue)' : ''}`
    : 'floor off';
  return [
    `pass mark ${passMark}`,
    rules.minimalGate.enabled ? 'mandatory gate on' : 'mandatory gate off',
    rules.minimalCeiling.enabled ? `ceiling on at ${rules.minimalCeiling.score}` : 'ceiling off',
    floor,
    rules.expectedCoverage.enabled ? 'expected-coverage cap on' : 'expected-coverage cap off',
  ].join('; ');
}

/** The rules both sides are recomputed under, and where they came from. */
export type ResolvedScoringConfig = {
  rules: ScoringRules;
  passMark: number;
  declaredA: boolean;
  declaredB: boolean;
  /** Every complaint either file's block earned, plus any note about a caller override. */
  warnings: string[];
};

/**
 * Resolves ONE scoring configuration for both sides.
 *
 * A declared `pass_mark.score` wins over `options.passMark`, because the declaration says what the
 * grades in that file were produced under and the CLI always passes a mark; the override is
 * reported as overridden rather than dropped silently. **Throws** when the two files' effective
 * configurations differ: the sides would then be measured by different rulers.
 */
export function resolveScoringConfig(
  a: EvalFile,
  b: EvalFile,
  options: { labelA: string; labelB: string; passMark?: number | null },
): ResolvedScoringConfig {
  const fallback = options.passMark ?? DEFAULT_PASS_MARK;
  const sides = ([
    [options.labelA, a],
    [options.labelB, b],
  ] as const).map(([label, file]) => {
    const resolved = applyScoringOverrides(file.scoring_config, `${label}: scoring_config`);
    const passMark = resolved.passMarkDeclared ? resolved.passMark : fallback;
    const warnings = [...resolved.warnings];
    if (resolved.passMarkDeclared && options.passMark != null && resolved.passMark !== options.passMark) {
      warnings.push(
        `${label}: scoring_config declares pass_mark.score ${resolved.passMark}, which overrides the ` +
          `pass mark ${options.passMark} given by the caller.`,
      );
    }
    return { label, resolved, passMark, warnings };
  });

  const [sideA, sideB] = sides;
  const key = (side: (typeof sides)[number]) => JSON.stringify({ rules: side.resolved.rules, passMark: side.passMark });
  if (key(sideA) !== key(sideB)) {
    const line = (side: (typeof sides)[number]) =>
      `  ${side.label}: ${describeScoringRules(side.resolved.rules, side.passMark)} ` +
      `[${side.resolved.declared ? 'declared in the file' : 'shipped defaults'}]`;
    throw new Error(
      'Cannot compare: the two eval.json files resolve to different scoring_config rules, so each ' +
        "side's numbers would come from a different ruler and the comparison would measure the rules " +
        'rather than the judgment.\n' +
        `${line(sideA)}\n${line(sideB)}\n` +
        'Re-export or re-consolidate both sides under one scoring_config, or drop the block from ' +
        'both to use the shipped defaults.',
    );
  }

  return {
    rules: sideA.resolved.rules,
    passMark: sideA.passMark,
    declaredA: sideA.resolved.declared,
    declaredB: sideB.resolved.declared,
    // Both sides resolved identically, so B's complaints about its own block are the only ones
    // A's do not already cover; deduplicated by text, keeping A's order.
    warnings: [...sideA.warnings, ...sideB.warnings.filter((w) => !sideA.warnings.includes(w))],
  };
}

// ---- per-side scoring ---------------------------------------------------------------------------

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
  /** The grader's judged Completeness as the file carries it; null when it carries none. */
  completenessJudged: number | null;
  /** The expected-concept coverage share the cap is taken from. */
  coveragePct: number | null;
  /** What fed the weighted score: `min(judged, coverage)`, or the coverage share on its own. */
  completeness: number | null;
  relevance: number | null;
  clarity: number | null;
  /** The weighted score before the floor and the ceiling. */
  weighted: number | null;
  /** The mandatory floor's value, only where it actually raised the score. */
  floor: number | null;
  floorApplied: boolean;
  /** The Pre-Gate Content Score — the arithmetic before the ceiling. Diagnostic, never averaged. */
  preGateScore: number | null;
  /** The mandatory ceiling's value, only where it actually lowered the score. */
  ceiling: number | null;
  ceilingApplied: boolean;
  /** True only where the coverage cap actually lowered the grader's judged Completeness. */
  coverageApplied: boolean;
  overall: number | null;
  grade: Grade | null;
  status: CaseStatus | null;
  /** Where the Result came from: the pass mark, the automatic Pass, or the mandatory gate. */
  statusSource: StatusSource | null;
  /** `null` when the side recorded no concepts block for the case. */
  mandatory: ConceptVerdicts | null;
  expected: ConceptVerdicts | null;
  materialIssue: boolean | null;
  evalConfidence: number | null;
  inReviewQueue: boolean;
};

export type SideOptions = { passMark: number; reviewThreshold: number; rules: ScoringRules };

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

/** A judged Completeness only where the file actually carries a number; otherwise null (coverage). */
function judgedCompleteness(c: EvalCase): number | null {
  return typeof c.completeness === 'number' && Number.isFinite(c.completeness) ? c.completeness : null;
}

/** Scores one side of one case through `deriveCaseScoreline`, under the rules in force. */
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
    completenessJudged: null,
    coveragePct: null,
    completeness: null,
    relevance: null,
    clarity: null,
    weighted: null,
    floor: null,
    floorApplied: false,
    preGateScore: null,
    ceiling: null,
    ceilingApplied: false,
    coverageApplied: false,
    overall: null,
    grade: null,
    status: null,
    statusSource: null,
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
  if (!concepts) return ute(NO_EXPECTED_CONCEPTS_UTE_REASON);

  // The whole pipeline, from the one place it exists: coverage cap → weight → floor → pre-gate →
  // ceiling → Result. Null only for a case with no expected concepts, which is Unable to Evaluate.
  const scoreline = deriveCaseScoreline({
    accuracy,
    completenessJudged: judgedCompleteness(c),
    relevance,
    clarity,
    concepts,
    rules: options.rules,
    passMark: options.passMark,
  });
  if (!scoreline) return ute(NO_EXPECTED_CONCEPTS_UTE_REASON);

  return {
    ...base,
    unableToEvaluate: false,
    uteReason: null,
    accuracy,
    completenessJudged: scoreline.completenessJudged,
    coveragePct: scoreline.coveragePct,
    completeness: scoreline.completeness,
    relevance,
    clarity,
    weighted: scoreline.weighted,
    floor: scoreline.floor,
    floorApplied: scoreline.floorApplied,
    preGateScore: scoreline.preGateScore,
    ceiling: scoreline.ceiling,
    ceilingApplied: scoreline.ceilingApplied,
    coverageApplied: scoreline.coverageApplied,
    overall: scoreline.overall,
    grade: scoreline.grade,
    status: scoreline.status,
    statusSource: scoreline.statusSource,
    // Bex's SME review queue is "at or below" the low-confidence threshold (metrics.ts), not below.
    inReviewQueue: evalConfidence != null && evalConfidence <= options.reviewThreshold,
  };
}

/**
 * The named rules that actually moved this side's number or its Result — the "why" behind a spread.
 * Empty when the plain weighted arithmetic and the pass mark decided everything.
 */
export function sideRuleNotes(side: SideEvaluation): string[] {
  const notes: string[] = [];
  if (side.coverageApplied && side.coveragePct != null) notes.push(`coverage cap ${side.coveragePct}`);
  if (side.floorApplied && side.floor != null) notes.push(`floor ${side.floor}`);
  if (side.ceilingApplied && side.ceiling != null) notes.push(`ceiling ${side.ceiling}`);
  if (side.statusSource === 'minimal_gate') notes.push('gate');
  if (side.statusSource === 'auto_pass') notes.push('auto-Pass');
  return notes;
}

/** `sideRuleNotes` as one cell; an em dash when no rule moved the side. */
export function formatSideRules(side: SideEvaluation): string {
  const notes = sideRuleNotes(side);
  return notes.length === 0 ? '—' : notes.join(', ');
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

export type SpreadCase = {
  id: string;
  overallA: number;
  overallB: number;
  delta: number;
  explained: boolean;
  /** The Pre-Gate Content Score behind each side's number — a near miss vs a total one. */
  preGateA: number | null;
  preGateB: number | null;
  /** `formatSideRules` per side, so the row says WHY the two differ (e.g. one side gated). */
  rulesA: string;
  rulesB: string;
};

export type TargetCheck = {
  name: string;
  target: string;
  actual: string;
  met: boolean | null;
  note: typeof PROPOSED_TARGET_NOTE;
};

export type ParityRollup = {
  passMark: number;
  /** B0-835 — the four concept rules both sides were recomputed under. */
  scoringRules: ScoringRules;
  /** Whether each file declared the `scoring_config` the rules came from. */
  scoringConfigDeclaredA: boolean;
  scoringConfigDeclaredB: boolean;
  /** Complaints either file's `scoring_config` earned, and any caller override it displaced. */
  scoringConfigWarnings: string[];
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
  /** The Pass/Fail line, unless a file's `scoring_config` declares one — a declaration wins. */
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

/**
 * Pairs cases by `id` and computes every per-case row and rollup, both sides recomputed under the
 * one configuration `resolveScoringConfig` settled on. **Throws** when the two files declare
 * configurations that resolve differently.
 */
export function compareEvalRuns(a: EvalFile, b: EvalFile, options: CompareOptions = {}): ParityComparison {
  const labels = { a: options.labelA ?? 'Bex', b: options.labelB ?? 'Desktop' };
  const config = resolveScoringConfig(a, b, {
    labelA: labels.a,
    labelB: labels.b,
    passMark: options.passMark,
  });
  const passMark = config.passMark;
  const spreadThreshold = options.spreadThreshold ?? DEFAULT_SPREAD_THRESHOLD;
  const reviewThreshold = options.reviewThreshold ?? DEFAULT_JUDGED_THRESHOLDS.lowConfidence;
  const sideOptions: SideOptions = { passMark, reviewThreshold, rules: config.rules };

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
      ? [
          {
            id: c.id,
            overallA: c.a.overall,
            overallB: c.b.overall,
            delta: c.delta,
            explained: c.conceptDisagreement,
            preGateA: c.a.preGateScore,
            preGateB: c.b.preGateScore,
            rulesA: formatSideRules(c.a),
            rulesB: formatSideRules(c.b),
          },
        ]
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
    labels,
    cases,
    rollup: {
      passMark,
      scoringRules: config.rules,
      scoringConfigDeclaredA: config.declaredA,
      scoringConfigDeclaredB: config.declaredB,
      scoringConfigWarnings: config.warnings,
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
const onOff = (enabled: boolean): string => (enabled ? 'on' : 'off');

/** `overall Result`, plus the named rules that moved it — a cell that explains its own number. */
function sideCell(side: SideEvaluation): string {
  if (side.unableToEvaluate) return 'UTE';
  const notes = sideRuleNotes(side);
  const head = `${num(side.overall)} ${side.status ?? ''}`.trim();
  return notes.length === 0 ? head : `${head} (${notes.join(', ')})`;
}

/** The whole study as one Markdown document: rollups, targets, spread cases, tables, per-case rows. */
export function renderParityMarkdown(result: ParityComparison): string {
  const { labels, rollup: r, cases } = result;
  const rules = r.scoringRules;
  const out: string[] = [];

  const source = r.scoringConfigDeclaredA
    ? r.scoringConfigDeclaredB
      ? 'declared in both files'
      : `declared in ${labels.a} only`
    : r.scoringConfigDeclaredB
      ? `declared in ${labels.b} only`
      : 'the shipped defaults (neither file declares a scoring_config)';

  out.push(`# Grading parity — ${labels.a} vs ${labels.b} (B0-824)`, '');
  out.push(
    `Both sides are re-scored from their judged sub-scores and concept verdicts through the same ` +
      `deterministic pipeline (B0-835), in this fixed order: Completeness = min(judged Completeness, ` +
      `expected-concept coverage)${rules.expectedCoverage.enabled ? '' : ' — coverage cap DISABLED here, so the judged value stands'}` +
      `, and the coverage share alone where a file carries no judged value; ` +
      `overall = 0.40·A + 0.30·C + 0.20·R + 0.10·Cl (half-up); ` +
      (rules.minimalFloor.enabled
        ? `a case satisfying every mandatory concept is raised to at least ${rules.minimalFloor.score}` +
          `${rules.minimalFloor.respectMaterialIssue ? ', unless a material factual issue is flagged' : ''}; `
        : 'the mandatory floor is disabled; ') +
      `the Pre-Gate Content Score is captured there, before the cap; ` +
      (rules.minimalCeiling.enabled
        ? `a case missing any mandatory concept is capped at ${rules.minimalCeiling.score}; `
        : 'the mandatory ceiling is disabled; ') +
      (rules.minimalGate.enabled
        ? 'and that case is rated Fail whatever its score, which outranks the automatic Pass full ' +
          'expected coverage earns. '
        : 'the mandatory gate is disabled, so a missing must-have concept does not by itself fail a case. ') +
      `Pass at ≥ ${r.passMark}. The rules in force are ${source}. ` +
      `Only the *derived* numbers a file carries (a weighted score, a grade, a status) are ignored — a ` +
      `judged Completeness is an input, not a derived value. ` +
      `Δ is |overall ${labels.a} − overall ${labels.b}|; spread = Δ ≥ ${r.spreadThreshold}; ` +
      `review queue = eval_confidence ≤ ${r.reviewThreshold}. ` +
      `Rollups are over the ${r.compared} matched cases both sides could evaluate (like-for-like), so they will not equal either side's own report.`,
    '',
  );

  out.push('## Rules in force', '');
  out.push(
    mdTable(
      ['Rule', 'Setting'],
      [
        ['Pass mark', `≥ ${r.passMark} rates Pass`],
        ['Mandatory gate (Rule 1)', onOff(rules.minimalGate.enabled)],
        [
          'Mandatory ceiling',
          rules.minimalCeiling.enabled ? `on — capped at ${rules.minimalCeiling.score}` : 'off',
        ],
        [
          'Mandatory floor (Rule 1b)',
          rules.minimalFloor.enabled
            ? `on — raised to ${rules.minimalFloor.score}` +
              (rules.minimalFloor.respectMaterialIssue ? ', withheld on a material factual issue' : '')
            : 'off',
        ],
        ['Expected-coverage cap (Rule 3)', onOff(rules.expectedCoverage.enabled)],
        ['Source', source],
      ],
    ),
    '',
  );
  if (r.scoringConfigWarnings.length > 0) {
    out.push(
      `Warnings from the declared \`scoring_config\`:`,
      ...r.scoringConfigWarnings.map((w) => `- ${w}`),
      '',
    );
  }

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
          [
            'Case',
            labels.a,
            labels.b,
            'Δ',
            `Pre-gate ${labels.a}`,
            `Pre-gate ${labels.b}`,
            `Rules ${labels.a}`,
            `Rules ${labels.b}`,
            'Explained by concept disagreement',
          ],
          r.spreadCases.map((s) => [
            s.id,
            String(s.overallA),
            String(s.overallB),
            String(s.delta),
            num(s.preGateA),
            num(s.preGateB),
            s.rulesA,
            s.rulesB,
            yn(s.explained),
          ]),
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
