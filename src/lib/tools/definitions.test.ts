import { describe, expect, it } from 'vitest';

import { DILUTION_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/dilution-specialist/dilution-specialist-system-prompt';
import { FLOOR_CONCRETE_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-concrete-specialist-system-prompt';
import { FLOOR_STG_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-stg-specialist-system-prompt';
import { FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-vct-specialist-system-prompt';
import { FLOOR_WOOD_SPORT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-wood-sport-specialist-system-prompt';
import { PRODUCT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/product-specialist/product-specialist-system-prompt';
import { RECOMMENDATIONS_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/recommendations-specialist/recommendations-specialist-system-prompt';
import {
  productSupportTools,
  productSupportToolsForRoute,
} from '~/lib/tools/definitions';
import { RETRIEVAL_TOOL_NAMES } from '~/lib/openai/responses-runtime';
import { getToolExample } from '~/lib/tools/examples';
import { DEFAULT_TOOL_TIMEOUT_MS, resolveToolTimeoutMs } from '~/lib/tools/tool-timeouts';
import {
  getDispenserAssetInputSchema,
  getFloorAssetInputSchema,
  PRODUCT_TOOL_NAMES,
} from '~/lib/tools/tool-schemas';
import {
  BATHROOM_SPECIALIST_SYSTEM_PROMPT,
  PRODUCT_SUPPORT_SHARED_INSTRUCTIONS,
} from '~/lib/workflows/product-support/product-support-prompts';

const ROUTES = [
  'product',
  'ambiguous',
  'bathroom',
  'dilution',
  'floor_wood_sport',
  'floor_concrete',
  'floor_stg',
  'floor_vct',
  'recommendations',
];

/** Every specialist policy the product-support workflow can actually run, by routing decision. */
const SPECIALIST_PROMPT_BY_ROUTE: Record<string, string> = {
  product: PRODUCT_SPECIALIST_SYSTEM_PROMPT,
  ambiguous: PRODUCT_SPECIALIST_SYSTEM_PROMPT,
  bathroom: BATHROOM_SPECIALIST_SYSTEM_PROMPT,
  dilution: DILUTION_SPECIALIST_SYSTEM_PROMPT,
  floor_wood_sport: FLOOR_WOOD_SPORT_SPECIALIST_SYSTEM_PROMPT,
  floor_concrete: FLOOR_CONCRETE_SPECIALIST_SYSTEM_PROMPT,
  floor_stg: FLOOR_STG_SPECIALIST_SYSTEM_PROMPT,
  floor_vct: FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT,
  recommendations: RECOMMENDATIONS_SPECIALIST_SYSTEM_PROMPT,
};

const ALL_TOOL_NAMES_IN_DEFINITION_ORDER = productSupportTools.map((tool) =>
  tool.type === 'function' ? tool.name : '',
);

function toolNames(route: string): string[] {
  return productSupportToolsForRoute(route).map((tool) =>
    tool.type === 'function' ? tool.name : '',
  );
}

/** Tool names the prompt text mentions, so the assertion tracks the prompts rather than a copy of them. */
function toolsNamedIn(prompt: string): string[] {
  return PRODUCT_TOOL_NAMES.filter((name) => prompt.includes(name));
}

describe('productSupportToolsForRoute (B0-437)', () => {
  it('exposes every tool the route’s own prompt names', () => {
    for (const route of ROUTES) {
      const available = toolNames(route);
      const required = [
        ...toolsNamedIn(PRODUCT_SUPPORT_SHARED_INSTRUCTIONS),
        ...toolsNamedIn(SPECIALIST_PROMPT_BY_ROUTE[route] ?? ''),
      ];

      expect(required.length, `${route} prompt names at least one tool`).toBeGreaterThan(0);
      for (const name of required) {
        expect(available, `${route} must expose ${name}`).toContain(name);
      }
    }
  });

  it('keeps search_product_docs on every route', () => {
    for (const route of ROUTES) {
      expect(toolNames(route)).toContain('search_product_docs');
    }
  });

  it('keeps the FULL set on the catch-all routes (product + ambiguous)', () => {
    expect(toolNames('product')).toEqual(ALL_TOOL_NAMES_IN_DEFINITION_ORDER);
    expect(toolNames('ambiguous')).toEqual(ALL_TOOL_NAMES_IN_DEFINITION_ORDER);
    expect(new Set(toolNames('product'))).toEqual(new Set(PRODUCT_TOOL_NAMES));
  });

  it('falls back to the full set for an unknown route', () => {
    expect(productSupportToolsForRoute('not-a-route')).toBe(productSupportTools);
    expect(productSupportToolsForRoute('')).toBe(productSupportTools);
  });

  it('prunes only the category-navigation tools, and only where they do not apply', () => {
    const category = ['get_products_in_category', 'get_product_category', 'find_products_by_category'];

    for (const route of ['dilution']) {
      for (const name of category) {
        expect(toolNames(route), `${route} should not carry ${name}`).not.toContain(name);
      }
    }
    // Catalog/filter questions do land on these routes ("what floor strippers do you have?").
    // B0-734 — recommendations joins them: its B0-663 policy names the category tools.
    for (const route of [
      'bathroom',
      'floor_wood_sport',
      'floor_concrete',
      'floor_stg',
      'floor_vct',
      'recommendations',
    ]) {
      for (const name of category) {
        expect(toolNames(route)).toContain(name);
      }
    }
  });

  it('never invents a tool that is not a real product tool', () => {
    for (const route of ROUTES) {
      for (const name of toolNames(route)) {
        expect(PRODUCT_TOOL_NAMES as readonly string[]).toContain(name);
      }
    }
  });

  /**
   * B0-324 — the tool schemas are part of the cacheable prefix, so a given route must always produce
   * the same set, in the same order, for the prompt cache key to describe a stable prefix.
   */
  it('is a pure function of the route: same set, same order, every call', () => {
    for (const route of ROUTES) {
      expect(toolNames(route)).toEqual(toolNames(route));
      // Definition order is preserved (never re-sorted per route).
      const scoped = toolNames(route);
      expect(scoped).toEqual(
        ALL_TOOL_NAMES_IN_DEFINITION_ORDER.filter((name) => scoped.includes(name)),
      );
    }
  });

  it('actually shrinks the schema payload on the pruned routes', () => {
    const fullChars = JSON.stringify(productSupportTools).length;
    for (const route of ['dilution', 'recommendations']) {
      expect(JSON.stringify(productSupportToolsForRoute(route)).length).toBeLessThan(fullChars);
    }
  });
});

/**
 * B0-529 — the classic failure mode for a new tool is being wired into some sites and not others,
 * so this asserts every site at once: definition, name enum, route scoping, timeout, and the
 * retrieval-tool set the Responses runtime uses for its unproductive-call guard.
 */
describe('get_dispenser_asset / get_floor_asset wiring (B0-529)', () => {
  const NEW_TOOLS = ['get_dispenser_asset', 'get_floor_asset'] as const;

  it('is a real product tool with a definition', () => {
    for (const name of NEW_TOOLS) {
      expect(PRODUCT_TOOL_NAMES as readonly string[]).toContain(name);
      expect(productSupportTools.some((t) => 'name' in t && t.name === name)).toBe(true);
    }
  });

  it('scopes each tool to the route whose prompt names it, and nowhere else', () => {
    expect(toolNames('dilution')).toContain('get_dispenser_asset');
    expect(toolNames('dilution')).not.toContain('get_floor_asset');

    for (const route of ['floor_wood_sport', 'floor_concrete', 'floor_stg', 'floor_vct']) {
      expect(toolNames(route)).toContain('get_floor_asset');
      expect(toolNames(route)).not.toContain('get_dispenser_asset');
    }

    for (const route of ['bathroom', 'recommendations']) {
      for (const name of NEW_TOOLS) {
        expect(toolNames(route), `${route} should not carry ${name}`).not.toContain(name);
      }
    }
  });

  it('is reachable from the catch-all routes like every other tool', () => {
    for (const route of ['product', 'ambiguous']) {
      for (const name of NEW_TOOLS) {
        expect(toolNames(route)).toContain(name);
      }
    }
  });

  it('resolves a tool-execution timeout (no unbounded call)', () => {
    for (const name of NEW_TOOLS) {
      expect(resolveToolTimeoutMs(name)).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    }
  });

  it('counts as retrieval for the unproductive-retrieval guard', () => {
    for (const name of NEW_TOOLS) {
      expect(RETRIEVAL_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  it('has an admin example payload that satisfies its own schema', () => {
    expect(getDispenserAssetInputSchema.safeParse(getToolExample('get_dispenser_asset')).success).toBe(
      true,
    );
    expect(getFloorAssetInputSchema.safeParse(getToolExample('get_floor_asset')).success).toBe(true);
  });

  it('tells the model to transcribe regulated values exactly', () => {
    for (const name of NEW_TOOLS) {
      const def = productSupportTools.find((t) => 'name' in t && t.name === name);
      expect((def as { description: string }).description).toMatch(/exactly as written/);
    }
  });
});
