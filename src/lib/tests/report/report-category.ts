import { z } from 'zod';

import type { TestItemRecord } from '~/lib/tests/types';

/**
 * B0-853 — the category of record for run reports and grader context.
 *
 * Decision (epic B0-848, option a): the dataset's human-authored `question_category` — the golden
 * CSV's `category` column, which the importer (`~/lib/tests/csv.ts`) stores under
 * `test_items.input_payload.question_category` — is what a run report groups by and what the
 * grader is told about a case. It is the label the people curating the golden sets wrote, it is
 * what the desktop agent-evaluation skill already groups by, and category never feeds a score.
 * `test_items.prompt_category` (the keyword-classifier slug written by the
 * `test_items_classify_prompt` trigger) remains for the failure-queue page and manual overrides;
 * here it is only the fallback for an item imported without a `question_category`.
 *
 * Regulated-data rule: the category is copied verbatim apart from trimming surrounding whitespace —
 * never re-cased, slugified or mapped onto another vocabulary.
 */

export const UNCATEGORIZED_CATEGORY = 'Uncategorized';

/** Just the one key — the rest of `input_payload` is left to its own readers. */
const questionCategoryPayloadSchema = z.object({
  question_category: z.string().optional().nullable(),
});

export type ReportCategorySource = Pick<TestItemRecord, 'input_payload' | 'prompt_category'>;

/**
 * Trimmed non-empty `input_payload.question_category` → else `prompt_category` (trimmed,
 * non-empty) → else `'Uncategorized'`. Never throws: a payload that is not an object, or carries
 * the key with a non-string value, simply falls through to `prompt_category`.
 */
export function resolveReportCategory(item: ReportCategorySource): string {
  const parsed = questionCategoryPayloadSchema.safeParse(item.input_payload);
  const questionCategory = parsed.success ? parsed.data.question_category?.trim() : undefined;
  if (questionCategory) return questionCategory;

  const promptCategory = item.prompt_category?.trim();
  if (promptCategory) return promptCategory;

  return UNCATEGORIZED_CATEGORY;
}
