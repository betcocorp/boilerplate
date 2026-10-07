import rawQuestions from './product-catalog-specialist-questions.json';

export type ProductCatalogExpectedResultType =
  | 'answer'
  | 'list'
  | 'decline'
  | 'none'
  | '';

export type ProductCatalogTrainingRow = {
  question: string;
  should_answer: 'Yes' | 'No' | '';
  expected_result_type: ProductCatalogExpectedResultType;
  is_follow_up: string;
  canonical_product: string;
  product_mention: string;
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

/** Normalize imported JSON rows (drops empty legacy objects and the stray \`""\` property). */
export function normalizeProductCatalogTrainingRows(
  rows: unknown[],
): ProductCatalogTrainingRow[] {
  const out: ProductCatalogTrainingRow[] = [];

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
      expected_result_type: (cleaned.expected_result_type ?? '') as ProductCatalogExpectedResultType,
      is_follow_up: typeof cleaned.is_follow_up === 'string' ? cleaned.is_follow_up : '',
      canonical_product:
        typeof cleaned.canonical_product === 'string' ? cleaned.canonical_product : '',
      product_mention:
        typeof cleaned.product_mention === 'string' ? cleaned.product_mention : '',
      question_category:
        typeof cleaned.question_category === 'string' ? cleaned.question_category : '',
      reason_code: typeof cleaned.reason_code === 'string' ? cleaned.reason_code : '',
      reason_short: typeof cleaned.reason_short === 'string' ? cleaned.reason_short : '',
      reason_long: typeof cleaned.reason_long === 'string' ? cleaned.reason_long : '',
      source_style: typeof cleaned.source_style === 'string' ? cleaned.source_style : '',
      Notes: typeof cleaned.Notes === 'string' ? cleaned.Notes : '',
    });
  }

  return out;
}

/** Curated expectation set for the Betco Product Specialist (eval, routing tests, prompt regression). */
export const PRODUCT_CATALOG_TRAINING_QUESTIONS: ProductCatalogTrainingRow[] =
  normalizeProductCatalogTrainingRows(rawQuestions as unknown[]);

/** Questions grouped by \`question_category\` (stable for metrics and targeted tests). */
export function productCatalogQuestionsByCategory(): Map<
  string,
  ProductCatalogTrainingRow[]
> {
  const map = new Map<string, ProductCatalogTrainingRow[]>();

  for (const row of PRODUCT_CATALOG_TRAINING_QUESTIONS) {
    const key = row.question_category.trim() || '(uncategorized)';
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }

  return map;
}

export type ProductCatalogExpectationSummary = {
  total: number;
  shouldAnswerYes: number;
  shouldAnswerNo: number;
  byExpectedResult: Record<string, number>;
  byCategory: Record<string, number>;
};

export function summarizeProductCatalogExpectations(): ProductCatalogExpectationSummary {
  const byExpectedResult: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let shouldAnswerYes = 0;
  let shouldAnswerNo = 0;

  for (const row of PRODUCT_CATALOG_TRAINING_QUESTIONS) {
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
    total: PRODUCT_CATALOG_TRAINING_QUESTIONS.length,
    shouldAnswerYes,
    shouldAnswerNo,
    byExpectedResult,
    byCategory,
  };
}
