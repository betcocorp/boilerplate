import { MULTI_TURN_PAYLOAD_KEY, type MultiTurnScenario } from '~/lib/tests/multi-turn';
import type { Json } from '~/types/supabase.public';

/**
 * Builds `input_payload` / `metadata` for rows added via the admin "Add prompt" dialog.
 * Structured fields follow the same routing as CSV import (`csv.ts`).
 */
export function buildManualAddTestItemPayload(input: {
  prompt: string;
  /** Same keys as CSV columns routed into `input_payload`. */
  productMention: string | null;
  questionCategory: string | null;
  sourceStyle: string | null;
  /** B0-537 — stored under `input_payload.multi_turn`; null keeps the row single-turn. */
  multiTurnScenario?: MultiTurnScenario | null;
}): { input_payload: Record<string, Json>; metadata: Record<string, string> } {
  const input_payload: Record<string, Json> = {};
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
  if (input.multiTurnScenario) {
    input_payload[MULTI_TURN_PAYLOAD_KEY] = JSON.parse(
      JSON.stringify(input.multiTurnScenario),
    );
    metadata.multi_turn_turn_count = String(input.multiTurnScenario.turns.length);
  }

  metadata.added_via = 'manual_dialog';

  const trimmed = input.prompt.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  metadata.prompt_word_count = String(words.length);
  metadata.prompt_char_count = String([...input.prompt].length);

  return { input_payload, metadata };
}

function toJsonRecord(value: unknown): Record<string, Json> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, Json>) };
}

/**
 * Builds the `input_payload` / `metadata` patch when editing a prompt via the
 * admin dialog. Unlike {@link buildManualAddTestItemPayload}, this preserves any
 * keys already on the row (e.g. extra CSV columns) and only sets/clears the
 * three structured fields and the prompt-derived metadata the dialog manages.
 */
export function buildEditedTestItemPayload(input: {
  prompt: string;
  productMention: string | null;
  questionCategory: string | null;
  sourceStyle: string | null;
  /** B0-537 — null clears `input_payload.multi_turn`, turning the row back into a single-turn item. */
  multiTurnScenario?: MultiTurnScenario | null;
  existingInputPayload: unknown;
  existingMetadata: unknown;
}): {
  input_payload: Record<string, Json>;
  metadata: Record<string, Json>;
} {
  const input_payload = toJsonRecord(input.existingInputPayload);
  const metadata = toJsonRecord(input.existingMetadata);

  const applyPayloadField = (key: string, value: string | null) => {
    if (value) {
      input_payload[key] = value;
    } else {
      delete input_payload[key];
    }
  };
  applyPayloadField('product_mention', input.productMention);
  applyPayloadField('question_category', input.questionCategory);
  applyPayloadField('source_style', input.sourceStyle);

  if (input.multiTurnScenario) {
    input_payload[MULTI_TURN_PAYLOAD_KEY] = JSON.parse(
      JSON.stringify(input.multiTurnScenario),
    );
    metadata.multi_turn_turn_count = String(input.multiTurnScenario.turns.length);
  } else {
    delete input_payload[MULTI_TURN_PAYLOAD_KEY];
    delete metadata.multi_turn_turn_count;
  }

  metadata.edited_via = 'manual_dialog';

  const words = input.prompt.trim().split(/\s+/).filter(Boolean);
  metadata.prompt_word_count = String(words.length);
  metadata.prompt_char_count = String([...input.prompt].length);

  return { input_payload, metadata };
}
