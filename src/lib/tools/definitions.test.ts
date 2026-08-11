import { describe, expect, it } from 'vitest';

import { DILUTION_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/dilution-specialist/dilution-specialist-system-prompt';
import { FLOOR_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-specialist-system-prompt';
import { PRODUCT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/product-specialist/product-specialist-system-prompt';
import { RECOMMENDATIONS_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/recommendations-specialist/recommendations-specialist-system-prompt';
import {
  productSupportTools,
  productSupportToolsForRoute,
} from '~/lib/tools/definitions';
import { PRODUCT_TOOL_NAMES } from '~/lib/tools/tool-schemas';
import {
  BATHROOM_SPECIALIST_SYSTEM_PROMPT,
  PRODUCT_SUPPORT_SHARED_INSTRUCTIONS,
} from '~/lib/workflows/product-support/product-support-prompts';

const ROUTES = ['product', 'ambiguous', 'bathroom', 'dilution', 'floor', 'recommendations'];

/** Every specialist policy the product-support workflow can actually run, by routing decision. */
const SPECIALIST_PROMPT_BY_ROUTE: Record<string, string> = {
  product: PRODUCT_SPECIALIST_SYSTEM_PROMPT,
  ambiguous: PRODUCT_SPECIALIST_SYSTEM_PROMPT,
  bathroom: BATHROOM_SPECIALIST_SYSTEM_PROMPT,
  dilution: DILUTION_SPECIALIST_SYSTEM_PROMPT,
  floor: FLOOR_SPECIALIST_SYSTEM_PROMPT,
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

    for (const route of ['dilution', 'recommendations']) {
      for (const name of category) {
        expect(toolNames(route), `${route} should not carry ${name}`).not.toContain(name);
      }
    }
    // Catalog/filter questions do land on these routes ("what floor strippers do you have?").
    for (const route of ['bathroom', 'floor']) {
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
