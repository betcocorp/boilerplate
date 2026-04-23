import type { Json } from '~/types/supabase.public';

import type { TestItemRecord } from './types';

/** Rows used only to derive distinct dropdown values for the “Add prompt” dialog. */
export type TestItemSuggestionSource = Pick<
  TestItemRecord,
  | 'expected_result_type'
  | 'expected_canonical_product'
  | 'expected_reason_code'
  | 'input_payload'
>;

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
export function buildSuggestionListsFromTestItems(rows: TestItemSuggestionSource[]) {
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
