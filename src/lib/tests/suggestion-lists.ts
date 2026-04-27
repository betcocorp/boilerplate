import type { Json } from '~/types/supabase.public';
import { BATHROOM_SPECIALIST_TRAINING_QUESTIONS } from '~/lib/training/bathroom-specialist-expectations';
import { PRODUCT_CATALOG_TRAINING_QUESTIONS } from '~/lib/training/product-catalog-expectations';

import type { TestItemRecord } from './types';

/** Rows used only to derive distinct dropdown values for the “Add prompt” dialog. */
export type TestItemSuggestionSource = Pick<
  TestItemRecord,
  | 'expected_result_type'
  | 'expected_canonical_product'
  | 'expected_reason_code'
  | 'input_payload'
>;

export type SuggestionLists = {
  resultTypes: string[];
  canonicalProducts: string[];
  reasonCodes: string[];
  productMentions: string[];
  questionCategories: string[];
  sourceStyles: string[];
};

export function distinctNonEmptyStrings(values: (string | null | undefined)[]): string[] {
  const next = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== 'string') {
      continue;
    }
    const t = raw.trim();
    if (t) {
      next.add(t);
    }
  }
  return [...next].sort((a, b) => a.localeCompare(b));
}

function inputPayloadField(payload: Json | null, key: string): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const raw = (payload as Record<string, unknown>)[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/**
 * Unique suggestion strings from all `test_items` for this test:
 * typed columns plus `product_mention`, `question_category`, `source_style` from `input_payload`.
 */
export function buildSuggestionListsFromTestItems(rows: TestItemSuggestionSource[]): SuggestionLists {
  const resultTypes: string[] = [];
  const canonicalProducts: string[] = [];
  const reasonCodes: string[] = [];
  const productMentions: string[] = [];
  const questionCategories: string[] = [];
  const sourceStyles: string[] = [];

  for (const row of rows) {
    resultTypes.push(row.expected_result_type ?? '');
    canonicalProducts.push(row.expected_canonical_product ?? '');
    reasonCodes.push(row.expected_reason_code ?? '');

    const pm = inputPayloadField(row.input_payload, 'product_mention');
    const qc = inputPayloadField(row.input_payload, 'question_category');
    const ss = inputPayloadField(row.input_payload, 'source_style');
    if (pm) {
      productMentions.push(pm);
    }
    if (qc) {
      questionCategories.push(qc);
    }
    if (ss) {
      sourceStyles.push(ss);
    }
  }

  return {
    resultTypes: distinctNonEmptyStrings(resultTypes),
    canonicalProducts: distinctNonEmptyStrings(canonicalProducts),
    reasonCodes: distinctNonEmptyStrings(reasonCodes),
    productMentions: distinctNonEmptyStrings(productMentions),
    questionCategories: distinctNonEmptyStrings(questionCategories),
    sourceStyles: distinctNonEmptyStrings(sourceStyles),
  };
}

/**
 * Default options from curated training sets so brand-new datasets still
 * provide useful suggestions before any rows are added.
 */
export function buildAgentFallbackSuggestionLists(
  intendedAgent: string | null | undefined,
): SuggestionLists {
  if (intendedAgent === 'product') {
    return {
      resultTypes: distinctNonEmptyStrings(
        PRODUCT_CATALOG_TRAINING_QUESTIONS.map((row) => row.expected_result_type),
      ),
      canonicalProducts: distinctNonEmptyStrings(
        PRODUCT_CATALOG_TRAINING_QUESTIONS.map((row) => row.canonical_product),
      ),
      reasonCodes: distinctNonEmptyStrings(
        PRODUCT_CATALOG_TRAINING_QUESTIONS.map((row) => row.reason_code),
      ),
      productMentions: distinctNonEmptyStrings(
        PRODUCT_CATALOG_TRAINING_QUESTIONS.map((row) => row.product_mention),
      ),
      questionCategories: distinctNonEmptyStrings(
        PRODUCT_CATALOG_TRAINING_QUESTIONS.map((row) => row.question_category),
      ),
      sourceStyles: distinctNonEmptyStrings(
        PRODUCT_CATALOG_TRAINING_QUESTIONS.map((row) => row.source_style),
      ),
    };
  }

  if (intendedAgent === 'bathroom') {
    return {
      resultTypes: distinctNonEmptyStrings(
        BATHROOM_SPECIALIST_TRAINING_QUESTIONS.map((row) => row.expected_result_type),
      ),
      canonicalProducts: distinctNonEmptyStrings(
        BATHROOM_SPECIALIST_TRAINING_QUESTIONS.map((row) => row.canonical_topic),
      ),
      reasonCodes: distinctNonEmptyStrings(
        BATHROOM_SPECIALIST_TRAINING_QUESTIONS.map((row) => row.reason_code),
      ),
      productMentions: distinctNonEmptyStrings(
        BATHROOM_SPECIALIST_TRAINING_QUESTIONS.map((row) => row.topic_mention),
      ),
      questionCategories: distinctNonEmptyStrings(
        BATHROOM_SPECIALIST_TRAINING_QUESTIONS.map((row) => row.question_category),
      ),
      sourceStyles: distinctNonEmptyStrings(
        BATHROOM_SPECIALIST_TRAINING_QUESTIONS.map((row) => row.source_style),
      ),
    };
  }

  return {
    resultTypes: [],
    canonicalProducts: [],
    reasonCodes: [],
    productMentions: [],
    questionCategories: [],
    sourceStyles: [],
  };
}

export function mergeSuggestionLists(
  primary: SuggestionLists,
  fallback: SuggestionLists,
): SuggestionLists {
  return {
    resultTypes: distinctNonEmptyStrings([...primary.resultTypes, ...fallback.resultTypes]),
    canonicalProducts: distinctNonEmptyStrings([
      ...primary.canonicalProducts,
      ...fallback.canonicalProducts,
    ]),
    reasonCodes: distinctNonEmptyStrings([...primary.reasonCodes, ...fallback.reasonCodes]),
    productMentions: distinctNonEmptyStrings([
      ...primary.productMentions,
      ...fallback.productMentions,
    ]),
    questionCategories: distinctNonEmptyStrings([
      ...primary.questionCategories,
      ...fallback.questionCategories,
    ]),
    sourceStyles: distinctNonEmptyStrings([...primary.sourceStyles, ...fallback.sourceStyles]),
  };
}
