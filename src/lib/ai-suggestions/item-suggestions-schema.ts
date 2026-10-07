/**
 * B0-906 — strict JSON Schema for the test-item review call's structured output, mirroring the shape
 * the system prompt already asks for. It replaces `response_format: { type: 'json_object' }`, so the
 * tolerant wrapper-key parser in the action now only ever sees the `{ suggestions: [...] }` shape —
 * that parser is kept as-is because it also guards a hand-edited or legacy response.
 *
 * B0-922 — it lives here rather than beside the action because the action file is `'use server'`,
 * which may only export async functions, and `~/lib/llm/seam-schemas` has to be able to import it.
 */
export const ITEM_SUGGESTIONS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'content'],
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
        },
      },
    },
  },
} as const satisfies Record<string, unknown>;
