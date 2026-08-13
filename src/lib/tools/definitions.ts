import type { Tool } from 'openai/resources/responses/responses';

import type { ProductToolName } from '~/lib/tools/tool-schemas';

/**
 * B0-364: on the product-fact tools the `productId` parameter is really a product NAME
 * (it is resolved by name, never used as a database id). Models naturally send
 * `productName` instead — the spelling the prose uses — so both keys are accepted and
 * normalized to `productId` by the Zod schemas in `~/lib/tools/tool-schemas`.
 */
const PRODUCT_REF_PARAM = {
  type: 'string',
  description:
    'Betco product or product-line NAME or code (e.g. "pH7Q", "AF315", "4020"). Resolved by name — this is not a database id. Equivalent to `productName`.',
} as const;

const PRODUCT_NAME_ALIAS_PARAM = {
  type: 'string',
  description: 'Alias for `productId` — pass the product name here or there, not both.',
} as const;

/**
 * OpenAI Responses function tools — parameters are JSON Schema objects (strict mode off for flexibility).
 */
export const productSupportTools: Tool[] = [
  {
    type: 'function',
    name: 'search_product_docs',
    strict: false,
    description:
      'Search Betco product documentation (RAG). Use for general product + topic questions. Returns up to 3 sources where each source is a full approved document (read `documentBody`, not just `snippet`). Provide `topic` or `freeformQuery` — pass `freeformQuery` alone (and leave `productName` empty) when the product name is unknown.',
    parameters: {
      type: 'object',
      properties: {
        productName: {
          type: 'string',
          description: 'Specific Betco product name when known (e.g. "Green Earth All Purpose"). Leave empty when using freeformQuery.',
        },
        topic: {
          type: 'string',
          description:
            'Topic or question type (e.g. "dilution", "kill claims", "PPE"). Optional when `freeformQuery` is provided.',
        },
        surfaceType: {
          type: 'string',
          description: 'Optional surface context.',
        },
        freeformQuery: {
          type: 'string',
          description: 'Use instead of productName + topic for broad searches where the product is not yet known (e.g. "best product for removing mineral scale from toilet bowls").',
        },
      },
      // B0-362: `topic` is NOT required — the model is told to call this with `freeformQuery`
      // alone. At least one of freeformQuery / topic / productName / surfaceType must be set.
      required: [],
    },
  },
  {
    type: 'function',
    name: 'get_product_spec',
    strict: false,
    description:
      'Retrieve spec-oriented excerpts for a Betco product, identified by product NAME or code (e.g. "pH7Q", "AF315"). Pass it as `productId` or `productName` — both keys are accepted.',
    parameters: {
      type: 'object',
      properties: {
        productId: PRODUCT_REF_PARAM,
        productName: PRODUCT_NAME_ALIAS_PARAM,
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'get_approved_usage_guidance',
    strict: false,
    description:
      'Retrieve approved usage / procedure documentation for a product (by NAME, as `productId` or `productName`) on a given task and surface. Returns up to 3 full approved documents in `sources[].documentBody`.',
    parameters: {
      type: 'object',
      properties: {
        productId: PRODUCT_REF_PARAM,
        productName: PRODUCT_NAME_ALIAS_PARAM,
        task: { type: 'string' },
        surfaceType: { type: 'string' },
        environment: { type: 'string' },
      },
      required: ['task', 'surfaceType'],
    },
  },
  {
    type: 'function',
    name: 'get_safety_constraints',
    strict: false,
    description:
      'Retrieve safety / SDS-oriented documentation (PPE, hazards, precautions) for a product identified by NAME. Pass it as `productId` or `productName` — both keys are accepted. Returns up to 3 full approved documents in `sources[].documentBody`.',
    parameters: {
      type: 'object',
      properties: {
        productId: PRODUCT_REF_PARAM,
        productName: PRODUCT_NAME_ALIAS_PARAM,
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'get_compatibility_rules',
    strict: false,
    description:
      'Retrieve compatibility guidance for product (by NAME, as `productId` or `productName`) + surface (+ optional material).',
    parameters: {
      type: 'object',
      properties: {
        productId: PRODUCT_REF_PARAM,
        productName: PRODUCT_NAME_ALIAS_PARAM,
        surfaceType: { type: 'string' },
        materialType: { type: 'string' },
      },
      required: ['surfaceType'],
    },
  },
  {
    type: 'function',
    name: 'list_allowed_surfaces',
    strict: false,
    description:
      'Find documentation excerpts that describe allowed / compatible surfaces for a product identified by NAME. Pass it as `productId` or `productName` — both keys are accepted.',
    parameters: {
      type: 'object',
      properties: {
        productId: PRODUCT_REF_PARAM,
        productName: PRODUCT_NAME_ALIAS_PARAM,
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'list_disallowed_uses',
    strict: false,
    description:
      'Find documentation excerpts about prohibited uses, incompatibility, or warnings for a product identified by NAME. Pass it as `productId` or `productName` — both keys are accepted.',
    parameters: {
      type: 'object',
      properties: {
        productId: PRODUCT_REF_PARAM,
        productName: PRODUCT_NAME_ALIAS_PARAM,
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'get_escalation_policy',
    strict: false,
    description:
      'Returns internal escalation guidance by issue type (policy text, not customer-specific data).',
    parameters: {
      type: 'object',
      properties: {
        issueType: { type: 'string' },
      },
      required: ['issueType'],
    },
  },
  {
    type: 'function',
    name: 'get_products_in_category',
    strict: false,
    description:
      'Return Betco product lines that belong to a given website category (e.g. "Floor Care", "Disinfectants", "Odor Management"). Use this for filter-style questions like "what floor care products do you have?" or "show me all disinfectants". Pass the exact or approximate category name; set categoryLevel to narrow to prod_type, sub_prod_type, sub_child_prod_type, or prod_class.',
    parameters: {
      type: 'object',
      properties: {
        categoryName: {
          type: 'string',
          description: 'Category name to search for (e.g. "Floor Care", "Deodorizers", "Glass", "Air Care").',
        },
        categoryLevel: {
          type: 'string',
          enum: ['prod_type', 'sub_prod_type', 'sub_child_prod_type', 'prod_class', 'any'],
          description: 'Which level of the category hierarchy to match against. Defaults to "any".',
        },
        maxResults: {
          type: 'number',
          description: 'Max products to return (default 20, max 50).',
        },
      },
      required: ['categoryName'],
    },
  },
  {
    type: 'function',
    name: 'get_product_category',
    strict: false,
    description:
      'Return the website category (prod_type → sub_prod_type → sub_child_prod_type) for a specific Betco product. Use when the user asks what category a product falls under, or to find related products in the same category.',
    parameters: {
      type: 'object',
      properties: {
        productId: {
          type: 'string',
          description: 'Betco product name (e.g. "AF315") or product code (e.g. "315").',
        },
      },
      required: ['productId'],
    },
  },
  {
    type: 'function',
    name: 'find_products_by_category',
    strict: false,
    description:
      "Deterministically map a category query (e.g. \"floor strippers\", \"glass cleaner\", \"disinfectants\", \"hand soap\") to Betco's website product taxonomy and return the actual web products in that category — SKU, title, and canonical betco.com URL — with NO semantic search. Prefer this for filter-style questions like \"what floor strippers do you have?\" or \"show me all disinfectants\". If the query does not confidently match a category, the tool returns path:\"semantic\"; in that case fall back to search_product_docs.",
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Category or product-type phrase, e.g. "floor strippers", "glass cleaner", "warewashing detergents".',
        },
        maxResults: {
          type: 'number',
          description: 'Max products to return (default 25, max 50).',
        },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'lookup_cross_reference',
    strict: false,
    description:
      'Find Betco equivalent products from legacy cross-reference tables using a competitor brand and product name.',
    parameters: {
      type: 'object',
      properties: {
        brand: {
          type: 'string',
          description: 'Competitor brand, for example "Spartan".',
        },
        productName: {
          type: 'string',
          description: 'Competitor product name, for example "#1 Laundry Break".',
        },
        maxResults: {
          type: 'number',
          description: 'Optional max number of returned matches (default 3, max 10).',
        },
      },
      required: ['brand', 'productName'],
    },
  },
  {
    type: 'function',
    name: 'recommend_cross_reference',
    strict: false,
    description:
      "Web-grounded fallback for competitor cross-reference. Given a competitor product (and optional brand) that `lookup_cross_reference` could NOT confidently match, this researches it via web search, extracts its spec, and recommends the closest Betco equivalent product(s) with an overall confidence and evidence. Call this ONLY after `lookup_cross_reference` returns no match or `fallbackRecommended: true`. It returns `answered` or a decline — if declined, relay the decline reason verbatim and do NOT invent a product, SKU, or claim.",
    parameters: {
      type: 'object',
      properties: {
        competitorProduct: {
          type: 'string',
          description: 'Competitor product name (required), e.g. "BNC-15".',
        },
        competitorBrand: {
          type: 'string',
          description: 'Competitor brand/company if known (optional but improves confidence), e.g. "Spartan".',
        },
        maxResults: {
          type: 'number',
          description: 'Max Betco candidates to return (default 5, max 10).',
        },
      },
      required: ['competitorProduct'],
    },
  },
  {
    type: 'function',
    name: 'get_efficacy_data',
    strict: false,
    description:
      'Return VERIFIED structured facts for a product from the fact tables — dilution (oz/gal), contact/dwell time, EPA registration, and per-organism kill claims — plus, when available, the authoritative lab-report citation (formula, version, lab, Project #, and the raw PDF\'s S3 source) from the efficacy document corpus. This does NOT run prose/semantic retrieval; it reads the typed dilution/contact-time/EPA columns directly, so it is an EXACT lookup, not a paraphrase. Use it for dilution ratio questions and any efficacy / "what does it kill" / kill-claim / contact-time question. Returns `facts` and/or `labReport` with the verified values — each fact row carries its own `confidence` (default 1.0 = source-of-record; below 1.0 means treat it as less certain and say so) — cite the lab report`s source document id (see `sources`) per the standard `[doc:uuid]` convention when present, citing the specific version that generated the numbers even if a newer formula reuses that data. Returns `facts: null` (and `labReport: null`) plus a `note` only when NEITHER is on file — in that case do NOT estimate or infer a value; tell the user the data is not verified.',
    parameters: {
      type: 'object',
      properties: {
        productId: PRODUCT_REF_PARAM,
        productName: PRODUCT_NAME_ALIAS_PARAM,
        organism: {
          type: 'string',
          description: 'Optional organism/pathogen to filter kill claims, e.g. "Norovirus".',
        },
      },
      required: [],
    },
  },
];

/* -------------------------------------------------------------------------- *
 * B0-437 — route-scoped tool sets
 * -------------------------------------------------------------------------- *
 * The 14 definitions above serialize to ~11,140 chars (~2,785 tokens) and were sent on every model
 * call regardless of which specialist route the message landed on. This is the ONE place the
 * route → tool mapping lives.
 *
 * Inclusion rule (conservative by design — a tool missing when the model wants it is a hard failure,
 * while an extra schema only costs tokens):
 *   1. `PRODUCT_SUPPORT_SHARED_INSTRUCTIONS` names it, so every route can legitimately ask for it:
 *      `search_product_docs`, `get_efficacy_data`, `lookup_cross_reference`,
 *      `recommend_cross_reference`.
 *   2. It is a generic per-product retrieval tool, which the shared rules cover with
 *      "`search_product_docs` (or another retrieval tool)".
 *   3. The route's own specialist policy names it, or production traces show that route invoking it.
 *
 * `product` and `ambiguous` deliberately keep the FULL set: `ambiguous` is the routing catch-all and
 * `product` is the fallthrough specialist (together 92% of production runs), and 12 of the 14 tools
 * have been invoked on them in the last 30 days. Keeping their prefix whole also keeps it large, which
 * is what the B0-324 prompt cache reads back — pruning the dominant route would trade cached tokens
 * for uncached ones.
 *
 * Any route NOT listed here falls back to the full set.
 */

/** Rule 1 + rule 2: usable from any route. */
const BASE_ROUTE_TOOL_NAMES: readonly ProductToolName[] = [
  'search_product_docs',
  'get_efficacy_data',
  'lookup_cross_reference',
  'recommend_cross_reference',
  'get_product_spec',
  'get_approved_usage_guidance',
  'get_safety_constraints',
  'get_compatibility_rules',
  'list_allowed_surfaces',
  'list_disallowed_uses',
  'get_escalation_policy',
];

/** Website-taxonomy navigation — only meaningful for "what products do you have" style questions. */
const CATEGORY_ROUTE_TOOL_NAMES: readonly ProductToolName[] = [
  'get_products_in_category',
  'get_product_category',
  'find_products_by_category',
];

const ROUTE_TOOL_NAMES: Record<string, readonly ProductToolName[]> = {
  // Catalog/filter questions land here too ("what floor strippers do you have?"), so both the
  // bathroom and floor routes keep the category tools — production traces show both using them.
  bathroom: [...BASE_ROUTE_TOOL_NAMES, ...CATEGORY_ROUTE_TOOL_NAMES],
  floor: [...BASE_ROUTE_TOOL_NAMES, ...CATEGORY_ROUTE_TOOL_NAMES],
  // Dilution is always about a NAMED product's ratio/dispenser setup, never about browsing a
  // category; no dilution-route run has called a category tool.
  dilution: BASE_ROUTE_TOOL_NAMES,
  // The recommendations policy is cross-reference-first and has only ever used
  // lookup_cross_reference / recommend_cross_reference / search_product_docs.
  recommendations: BASE_ROUTE_TOOL_NAMES,
};

/**
 * Tool schemas for one resolved route, in the same order as `productSupportTools` (order is part of
 * the cached prefix, and of the B0-393 `promptBundleVersion` hash input).
 *
 * The result is a pure function of the route, so every call sharing a `promptCacheKey`
 * (`bex-product-support:<mode>:<decision>`) also shares a byte-identical tool set.
 */
export function productSupportToolsForRoute(route: string): Tool[] {
  const allowed = ROUTE_TOOL_NAMES[route];
  if (!allowed) {
    return productSupportTools;
  }
  const allowedSet = new Set<string>(allowed);
  return productSupportTools.filter(
    (tool) => tool.type === 'function' && allowedSet.has(tool.name),
  );
}
