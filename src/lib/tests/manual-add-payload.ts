/**
 * Builds `input_payload` / `metadata` for rows added via the admin "Add prompt" dialog.
 * Structured fields follow the same routing as CSV import (`csv.ts`).
 */
export function buildManualAddTestItemPayload(input: {
  prompt: string;
  expected_should_answer: boolean | null;
  /** Same keys as CSV columns routed into `input_payload`. */
  productMention: string | null;
  questionCategory: string | null;
  sourceStyle: string | null;
}): { input_payload: Record<string, string>; metadata: Record<string, string> } {
  const input_payload: Record<string, string> = {};
  const metadata: Record<string, string> = {};

  if (input.productMention) {
    input_payload.product_mention = input.productMention;
  }
  if (input.questionCategory) {
    input_payload.question_category = input.questionCategory;
  }
  if (input.sourceStyle) {
    input_payload.source_style = input.sourceStyle;
  }

  metadata.added_via = 'manual_dialog';

  const trimmed = input.prompt.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  metadata.prompt_word_count = String(words.length);
  metadata.prompt_char_count = String([...input.prompt].length);

  if (input.expected_should_answer === true) {
    metadata.expectation_mode = 'should_answer';
  } else if (input.expected_should_answer === false) {
    metadata.expectation_mode = 'should_decline';
  } else {
    metadata.expectation_mode = 'na';
  }

  return { input_payload, metadata };
}
