/**
 * B0-910 — JSON Schema fragments for the strict structured-output calls that go through
 * `~/lib/llm/structured-completion`, where the two providers do NOT accept the same spelling.
 *
 * A nullable enum written as `{ type: ['string', 'null'], enum: [...values, null] }` is accepted by
 * OpenAI's Responses validator but rejected outright by Anthropic's, which type-checks each enum
 * member against the declared type and 400s on the first one:
 *
 *   output_config.format.schema: Invalid schema: Enum value 'betco' does not match declared
 *   type '['string', 'null']'
 *
 * With `BEX_ROUTER_MODEL` on a `claude-*` tag that failed the router call outright, so every turn
 * silently degraded to the keyword fallback (`llm_route: ambiguous`, confidence 0). The `anyOf` form
 * below carries the same constraint and is accepted by both providers (verified live against
 * `claude-haiku-4-5` and `gpt-4.1`).
 */
export function nullableEnum(values: readonly string[]) {
  return { anyOf: [{ type: 'string', enum: [...values] }, { type: 'null' }] } as const;
}
