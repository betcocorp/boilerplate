import type { Json } from '~/types/supabase.public';

import type { TestItemRecord } from './types';

/** Rows used only to derive distinct dropdown values for the “Add prompt” dialog. */
export type TestItemSuggestionSource = Pick<
  TestItemRecord,
  | 'expected_canonical_products'
  | 'expected_reason_code'
  | 'source'
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

/** First non-empty string among keys (handles legacy camelCase vs CSV snake_case). */
function inputPayloadFieldFirst(payload: Json | null, keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = inputPayloadField(payload, key);
    if (v) {
      return v;
    }
  }
  return null;
}

/**
 * Unique suggestion strings from all `test_items` for this test:
 * typed columns plus `product_mention`, `question_category`, `source_style` from `input_payload`.
 */
export function buildSuggestionListsFromTestItems(rows: TestItemSuggestionSource[]) {
  const canonicalProducts: string[] = [];
  const reasonCodes: string[] = [];
  const sources: string[] = [];
  const productMentions: string[] = [];
  const questionCategories: string[] = [];
  const sourceStyles: string[] = [];

  for (const row of rows) {
    canonicalProducts.push(...(row.expected_canonical_products ?? []));
    reasonCodes.push(row.expected_reason_code ?? '');
    sources.push(row.source ?? '');

    const pm = inputPayloadFieldFirst(row.input_payload, [
      'product_mention',
      'productMention',
    ]);
    const qc = inputPayloadFieldFirst(row.input_payload, [
      'question_category',
      'questionCategory',
    ]);
    const ss = inputPayloadFieldFirst(row.input_payload, ['source_style', 'sourceStyle']);
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
    canonicalProducts: distinctNonEmptyStrings(canonicalProducts),
    reasonCodes: distinctNonEmptyStrings(reasonCodes),
    sources: distinctNonEmptyStrings(sources),
    productMentions: distinctNonEmptyStrings(productMentions),
    questionCategories: distinctNonEmptyStrings(questionCategories),
    sourceStyles: distinctNonEmptyStrings(sourceStyles),
  };
}
