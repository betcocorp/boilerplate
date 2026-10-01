import rawQuestions from './bathroom-specialist-questions.json';

/** Mirrors product-catalog expectation types for shared eval tooling. */
export type BathroomSpecialistExpectedResultType =
  | 'answer'
  | 'list'
  | 'decline'
  | 'none'
  | '';

export type BathroomSpecialistTrainingRow = {
  question: string;
  should_answer: 'Yes' | 'No' | '';
  expected_result_type: BathroomSpecialistExpectedResultType;
  is_follow_up: string;
  /** Primary restroom-care theme (empty when N/A for “should not” rows). */
  canonical_topic: string;
  topic_mention: string;
  question_category: string;
  reason_code: string;
  reason_short: string;
  reason_long: string;
  source_style: string;
  Notes: string;
};

function stripLegacyEmptyKey(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...row };
  delete next[''];
  return next;
}

/** Normalize imported JSON rows (drops empty legacy objects and the stray `""` property). */
export function normalizeBathroomSpecialistTrainingRows(
  rows: unknown[],
): BathroomSpecialistTrainingRow[] {
  const out: BathroomSpecialistTrainingRow[] = [];

  for (const item of rows) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const cleaned = stripLegacyEmptyKey(item as Record<string, unknown>);
    const q = cleaned.question;
    if (typeof q !== 'string' || !q.trim()) {
      continue;
    }

    out.push({
      question: q.trim(),
      should_answer:
        cleaned.should_answer === 'Yes' || cleaned.should_answer === 'No'
          ? cleaned.should_answer
          : '',
      expected_result_type: (cleaned.expected_result_type ??
        '') as BathroomSpecialistExpectedResultType,
      is_follow_up:
        typeof cleaned.is_follow_up === 'string' ? cleaned.is_follow_up : '',
      canonical_topic:
        typeof cleaned.canonical_topic === 'string'
          ? cleaned.canonical_topic
          : '',
      topic_mention:
        typeof cleaned.topic_mention === 'string' ? cleaned.topic_mention : '',
      question_category:
        typeof cleaned.question_category === 'string'
          ? cleaned.question_category
          : '',
      reason_code:
        typeof cleaned.reason_code === 'string' ? cleaned.reason_code : '',
      reason_short:
        typeof cleaned.reason_short === 'string' ? cleaned.reason_short : '',
      reason_long:
        typeof cleaned.reason_long === 'string' ? cleaned.reason_long : '',
      source_style:
        typeof cleaned.source_style === 'string' ? cleaned.source_style : '',
      Notes: typeof cleaned.Notes === 'string' ? cleaned.Notes : '',
    });
  }

  return out;
}

/**
 * Curated expectation set for the Betco Bathroom Specialist (eval, routing tests, prompt regression).
 * Sourced from “Top 100 Qs — Should & Shouldn’t Be Able to Answer”.
 */
export const BATHROOM_SPECIALIST_TRAINING_QUESTIONS: BathroomSpecialistTrainingRow[] =
  normalizeBathroomSpecialistTrainingRows(rawQuestions as unknown[]);

/** Questions grouped by `question_category` (stable for metrics and targeted tests). */
export function bathroomSpecialistQuestionsByCategory(): Map<
  string,
  BathroomSpecialistTrainingRow[]
> {
  const map = new Map<string, BathroomSpecialistTrainingRow[]>();

  for (const row of BATHROOM_SPECIALIST_TRAINING_QUESTIONS) {
    const key = row.question_category.trim() || '(uncategorized)';
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }

  return map;
}

export type BathroomSpecialistExpectationSummary = {
  total: number;
  shouldAnswerYes: number;
  shouldAnswerNo: number;
  byExpectedResult: Record<string, number>;
  byCategory: Record<string, number>;
};

export function summarizeBathroomSpecialistExpectations(): BathroomSpecialistExpectationSummary {
  const byExpectedResult: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let shouldAnswerYes = 0;
  let shouldAnswerNo = 0;

  for (const row of BATHROOM_SPECIALIST_TRAINING_QUESTIONS) {
    if (row.should_answer === 'Yes') {
      shouldAnswerYes += 1;
    } else if (row.should_answer === 'No') {
      shouldAnswerNo += 1;
    }

    const er = row.expected_result_type || '(empty)';
    byExpectedResult[er] = (byExpectedResult[er] ?? 0) + 1;

    const cat = row.question_category.trim() || '(uncategorized)';
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
  }

  return {
    total: BATHROOM_SPECIALIST_TRAINING_QUESTIONS.length,
    shouldAnswerYes,
    shouldAnswerNo,
    byExpectedResult,
    byCategory,
  };
}
