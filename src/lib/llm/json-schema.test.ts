import { describe, expect, it } from 'vitest';

import { nullableEnum } from '~/lib/llm/json-schema';
import {
  BRAND_FAMILIES,
  INTENT_CLASSIFICATION_JSON_SCHEMA,
  USE_SETTINGS,
} from '~/lib/orchestrator/intent-classifier';
import { SIGNALS_JSON_SCHEMA } from '~/lib/orchestrator/signals/analyze-turn-signals';
import { DECLINE_CLASSES } from '~/lib/orchestrator/signals/signals-schemas';
import { PRODUCT_TOOL_NAMES } from '~/lib/tools/tool-schemas';

type SchemaNode = Record<string, unknown>;

const isPlainObject = (value: unknown): value is SchemaNode =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every object node reachable from a schema root, with the JSON path that got there. */
function walkSchema(root: unknown, path = '$'): Array<{ path: string; node: SchemaNode }> {
  if (Array.isArray(root)) {
    return root.flatMap((child, index) => walkSchema(child, `${path}[${index}]`));
  }
  if (!isPlainObject(root)) return [];
  return [
    { path, node: root },
    ...Object.entries(root).flatMap(([key, child]) => walkSchema(child, `${path}.${key}`)),
  ];
}

/**
 * B0-910 — the class of bug, not the seven instances of it: a nullable enum spelled
 * `{ type: ['string', 'null'], enum: [...] }` passes OpenAI's validator and 400s on Anthropic's, so
 * the router silently degraded to keyword fallback on every turn once `BEX_ROUTER_MODEL` held a
 * `claude-*` tag. Any future field written that way fails here rather than in production.
 */
const PROVIDER_SCHEMAS = [
  { name: 'intent_classification', schema: INTENT_CLASSIFICATION_JSON_SCHEMA as unknown },
  { name: 'turn_signals', schema: SIGNALS_JSON_SCHEMA as unknown },
];

describe('nullableEnum (B0-910)', () => {
  it('emits the anyOf form both providers accept', () => {
    expect(nullableEnum(['a', 'b'])).toEqual({
      anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'null' }],
    });
  });

  it('never puts an enum next to an array type', () => {
    for (const { node } of walkSchema(nullableEnum(['a', 'b']))) {
      expect(Array.isArray(node.type) && 'enum' in node).toBe(false);
    }
  });
});

describe('router JSON schemas (B0-910)', () => {
  for (const { name, schema } of PROVIDER_SCHEMAS) {
    it(`${name}: no property declares an array type alongside an enum`, () => {
      const offenders = walkSchema(schema)
        .filter(({ node }) => Array.isArray(node.type) && 'enum' in node)
        .map(({ path }) => path);

      expect(offenders).toEqual([]);
    });

    // Guards the assertion above from passing vacuously if `walkSchema` ever stops descending.
    it(`${name}: the walk actually reaches the enum-bearing properties`, () => {
      const nodes = walkSchema(schema);
      expect(nodes.length).toBeGreaterThan(10);
      expect(nodes.filter(({ node }) => 'enum' in node).length).toBeGreaterThan(0);
    });
  }

  // The `anyOf` rewrite must stay semantically identical to the Zod contract
  // (`z.enum(...).nullable()`): all values, plus null.
  it.each([
    ['brandFamily', BRAND_FAMILIES],
    ['setting', USE_SETTINGS],
  ] as const)('intent_classification entities.%s allows every value and null', (field, values) => {
    expect(INTENT_CLASSIFICATION_JSON_SCHEMA.properties.entities.properties[field]).toEqual(
      nullableEnum(values),
    );
  });

  it('intent_classification suggestedTool allows every tool and null', () => {
    expect(INTENT_CLASSIFICATION_JSON_SCHEMA.properties.suggestedTool).toEqual(
      nullableEnum(PRODUCT_TOOL_NAMES),
    );
  });

  it.each([
    ['brandFamily', BRAND_FAMILIES],
    ['setting', USE_SETTINGS],
    ['suggestedTool', PRODUCT_TOOL_NAMES],
    ['declineClass', DECLINE_CLASSES],
  ] as const)('turn_signals %s allows every value and null', (field, values) => {
    expect(SIGNALS_JSON_SCHEMA.properties[field]).toEqual(nullableEnum(values));
  });
});
