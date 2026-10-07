import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { nullableEnum } from '~/lib/llm/json-schema';
import { SEAM_JSON_SCHEMAS } from '~/lib/llm/seam-schemas';
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
 *
 * B0-922 — the walk covers EVERY schema on the seam, not just the two that happened to break. The
 * set comes from `SEAM_JSON_SCHEMAS` rather than an ad-hoc import list here, so a new call site
 * registers itself once, in the registry the seam owns.
 */
const PROVIDER_SCHEMAS = SEAM_JSON_SCHEMAS;

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

describe('seam JSON schemas (B0-910, widened B0-922)', () => {
  it('the registry is non-empty and every entry names its call site', () => {
    expect(PROVIDER_SCHEMAS.length).toBeGreaterThan(10);
    for (const entry of PROVIDER_SCHEMAS) {
      expect(entry.name).not.toBe('');
      expect(entry.callSite).toMatch(/^src\//);
    }
  });

  for (const { name, callSite, schema } of PROVIDER_SCHEMAS) {
    it(`${name}: no property declares an array type alongside an enum`, () => {
      const offenders = walkSchema(schema)
        .filter(({ node }) => Array.isArray(node.type) && 'enum' in node)
        .map(({ path }) => `${path} (${callSite})`);

      expect(offenders).toEqual([]);
    });

    // Guards the assertion above from passing vacuously if `walkSchema` ever stops descending, or if
    // a registry entry resolves to something that is not a schema. Not every seam schema carries an
    // enum, so the non-vacuity check is "every declared property was visited", not "an enum was
    // seen" — that second half is asserted across the whole set below.
    it(`${name}: the walk reaches every declared property`, () => {
      const visited = new Set(walkSchema(schema).map(({ path }) => path));
      const properties = Object.keys(
        (schema as { properties?: Record<string, unknown> }).properties ?? {},
      );

      expect(properties.length).toBeGreaterThan(0);
      for (const property of properties) {
        expect(visited.has(`$.properties.${property}`)).toBe(true);
      }
    });
  }

  /**
   * B0-922 — the registry is only as good as its coverage, and nothing else forces a new call site
   * into it. Every literal `schemaName` in the app is a call on the seam, so the two sets must match
   * exactly: a new structured call fails here until its schema is registered and therefore walked.
   */
  it('registers every schemaName used anywhere in src', () => {
    const files = readdirSync('src', { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
      .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'));

    const used = new Set<string>();
    for (const file of files) {
      const source = readFileSync(join('src', file), 'utf8');
      // Anchored to a whole line so it matches the request property a call site writes, not an
      // unrelated `schemaName` parameter annotation (the RAG admin page has one).
      for (const match of source.matchAll(/^\s*schemaName:\s*'([^']+)',\s*$/gm)) {
        used.add(match[1]!);
      }
    }

    expect([...used].sort()).toEqual([...PROVIDER_SCHEMAS.map((s) => s.name)].sort());
  });

  it('the widened walk still reaches enum-bearing nodes', () => {
    const enumBearing = PROVIDER_SCHEMAS.flatMap(({ name, schema }) =>
      walkSchema(schema)
        .filter(({ node }) => 'enum' in node)
        .map(({ path }) => `${name}${path.slice(1)}`),
    );

    expect(enumBearing.length).toBeGreaterThan(0);
  });

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
