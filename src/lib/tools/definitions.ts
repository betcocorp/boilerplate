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
      'Search Betco product documentation (RAG). Use for general product + topic questions. Returns up to 3 sources where each source is a full approved document (read `documentBody`, not just `snippet`). Provide `topic` or `freeformQuery` — pass `freeformQuery` alone (and leave `productName` empty) when the product name is unknown. By default the "Size and package variants" section (SKUs, inventory IDs, web availability, MSRPs) is collapsed to a one-line note; set `includeVariants: true` when the question actually asks about sizes, SKUs, package options, or pricing.',
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
        includeVariants: {
          type: 'boolean',
          description:
            'Set true ONLY when the question asks about sizes, SKUs, package options, or pricing — returns the full "Size and package variants" section instead of the default one-line note.',
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
      'Return VERIFIED structured facts for a product from the fact tables — dilution (oz/gal), contact/dwell time, EPA registration, and per-organism kill claims — plus, when available, the authoritative lab-report citation (formula, version, lab, Project #, and the raw PDF\'s S3 source) from the efficacy document corpus. This does NOT run prose/semantic retrieval; it reads the typed dilution/contact-time/EPA columns directly, so it is an EXACT lookup, not a paraphrase. Use it for dilution ratio questions and any efficacy / "what does it kill" / kill-claim / contact-time question. Returns `facts` and/or `labReport` with the verified values — each fact row carries its own `confidence` (default 1.0 = source-of-record; below 1.0 means treat it as less certain and say so) — cite the lab report`s source document id (see `sources`) per the standard `[doc:uuid]` convention when present, citing the specific version that generated the numbers even if a newer formula reuses that data. When a lab-report excerpt shows a table with multiple organisms or multiple product/formula/version blocks, cite ONLY the row and table that name the exact product/formula/version asked about — never a sibling block in the same document. A "No Reduction" / "NR" / blank log-reduction cell is NEVER a positive kill claim: state the absence exactly as printed, or decline — never invert it into "yes, it reduced X" (B0-802). Returns `facts: null` (and `labReport: null`) plus a `note` only when NEITHER is on file — in that case do NOT estimate or infer a value; tell the user the data is not verified. Also returns `fastDrawDilution` (nullable, single-product form only) — dilution/yield figures specific to the FastDraw dispenser, kept as its OWN field rather than folded into `facts`: for some products it legitimately disagrees with `facts.dilutionDisplay` because the two describe different dilution contexts (general use vs. FastDraw). Match whichever field the question is actually asking about and never blend the two into one number. BATCH FORM: whenever you need this data for MORE THAN ONE product in the same turn (e.g. "compare the kill claims of these 5 disinfectants", or any per-category/per-line sweep), do NOT call this once per product — pass `productIds` (array of names/codes) or `category` instead of `productId`/`productName` to get every product\'s facts in ONE call. The batch response returns `results` (one entry per resolved product, each shaped like the single-product response) instead of top-level `facts`/`labReport`.',
    parameters: {
      type: 'object',
      properties: {
        productId: PRODUCT_REF_PARAM,
        productName: PRODUCT_NAME_ALIAS_PARAM,
        productIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'BATCH FORM: array of product names/codes to fetch efficacy data for in ONE call, instead of one `get_efficacy_data` call per product. Use this OR `productId`/`productName`, not both.',
        },
        category: {
          type: 'string',
          description:
            'BATCH FORM: fetch efficacy data for every product in this website category (e.g. "Disinfectants") in ONE call, instead of one `get_efficacy_data` call per product. Use this OR `productId`/`productIds`, not multiple.',
        },
        categoryLevel: {
          type: 'string',
          enum: ['prod_type', 'sub_prod_type', 'sub_child_prod_type', 'prod_class', 'any'],
          description: 'Only used with `category` — which level of the category hierarchy to match against. Defaults to "any".',
        },
        organism: {
          type: 'string',
          description: 'Optional organism/pathogen to filter kill claims, e.g. "Norovirus".',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'get_dispenser_asset',
    strict: false,
    description:
      'Retrieve Betco dispenser / dilution-control reference documents from the approved knowledge corpus — proportioner and dispenser setup guides, metering-tip selection, calibration procedures, and dilution-ratio calculation guides. Use this for "how is the dispenser set up / which tip / how do I calculate the ratio" questions, where the answer is a documented PROCEDURE rather than a per-product fact. For the exact verified dilution ratio of a specific product, call `get_efficacy_data` instead — this tool returns procedure text, not the fact tables. Returns up to 5 full knowledge documents in `sources[].documentBody`; transcribe any ratio, oz/gal, mL/L, or dwell time exactly as written and cite the source document id.',
    parameters: {
      type: 'object',
      properties: {
        dispenserModel: {
          type: 'string',
          description: 'Dispenser, proportioner, or dilution-control system name/model when the user named one.',
        },
        productName: {
          type: 'string',
          description: 'Betco product the dispenser is being set up for, when known.',
        },
        topic: {
          type: 'string',
          description:
            'What is being asked, e.g. "metering tip selection", "calibration", "dilution ratio chart", "installation".',
        },
        maxResults: {
          type: 'number',
          description: 'Max knowledge documents to return (default 3, max 5).',
        },
      },
      // At least one of dispenserModel / productName / topic must be set (enforced by the schema).
      required: [],
    },
  },
  {
    type: 'function',
    name: 'get_floor_asset',
    strict: false,
    description:
      'Retrieve Betco floor-care reference documents from the approved knowledge corpus — coat-count and coverage/yield charts, finish application and dry/cure guidance, top-scrub and recoat procedures, stripping procedures, and pad/equipment guides. Use this for "how many coats", "what coverage should I expect", "what is the top-scrub procedure" style questions on a named surface (VCT, terrazzo, concrete, wood). Returns up to 5 full knowledge documents in `sources[].documentBody`; transcribe coat counts, coverage figures, dry times, and dilution values exactly as written — never round, convert, or average them — and cite the source document id.',
    parameters: {
      type: 'object',
      properties: {
        surfaceType: {
          type: 'string',
          description: 'Floor surface named by the user, e.g. "VCT", "terrazzo", "sealed concrete", "hardwood".',
        },
        productName: {
          type: 'string',
          description: 'Betco or Basic Coatings product when the question names one.',
        },
        procedure: {
          type: 'string',
          description:
            'Procedure or chart wanted, e.g. "coat count", "coverage yield", "top scrub recoat", "stripping", "burnishing".',
        },
        maxResults: {
          type: 'number',
          description: 'Max knowledge documents to return (default 3, max 5).',
        },
      },
      // At least one of surfaceType / productName / procedure must be set (enforced by the schema).
      required: [],
    },
  },
  {
    type: 'function',
    name: 'web_search',
    strict: false,
    description:
      'General-purpose live web search — NOT a Betco data source. Use it only for things that cannot be on file in Betco\'s own corpus: confirming a competitor company/product\'s identity, general industry or regulatory-body background, or other current external information the user asked about. Do NOT use this for any Betco product fact — dilution ratio, EPA/DIN registration, kill claim, contact time, SDS/PPE data, spec, or compatibility rule — those must come from `get_efficacy_data`, `search_product_docs`, or the other approved-document tools; a web result is never a substitute for the approved corpus and must never be cited as one. Returns the same normalized shape as `/api/v1/tools/web-search`: `results[]` (title, url, snippet, score) plus `answer` and `metrics`. Pass `depth: "advanced"` only when a first `basic` search came back thin.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query.',
        },
        depth: {
          type: 'string',
          enum: ['basic', 'advanced'],
          description: 'Search depth. Defaults to "basic"; use "advanced" only when basic is insufficient.',
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional domain allowlist to restrict results to (e.g. ["epa.gov"]).',
        },
        maxResults: {
          type: 'number',
          description: 'Max results to return (default 5, max 20).',
        },
      },
      required: ['query'],
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

/**
 * B0-595 — `web_search` joins BASE even though it fits none of rules 1-3 by their letter: no
 * specialist prompt names it yet and it is too new to have production traces. It follows the
 * precedent those rules already concede, though — `recommend_cross_reference` is ALSO entirely
 * web-search-backed and already sits in BASE for every route. Scoping `web_search` any narrower
 * would leave the bathroom/dilution/floor/recommendations specialists able to research a
 * competitor or a non-Betco fact only indirectly, through `recommend_cross_reference`'s internal
 * search, but never directly — an arbitrary asymmetry with no basis in what those routes actually
 * need. The regulated-data boundary this tool requires (never ground a Betco dilution ratio, EPA
 * registration, kill claim, or contact time in a web result — that must still come from
 * `get_efficacy_data` / `search_product_docs` / the approved-document tools) is enforced in the
 * tool's own description above, not by withholding it from any route.
 */
/** Rule 1 + rule 2 (+ B0-595 web_search, see above): usable from any route. */
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
  'web_search',
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
  // B0-529: `get_floor_asset` is scoped to the floor routes only — the coat-count/coverage corpus
  // it reads is meaningless to the other specialists, and it is named in each floor policy
  // (rule 3). B0-746 split the single `floor` route into four substrate routes; all four keep the
  // same tool set the flat route had.
  floor_wood_sport: [...BASE_ROUTE_TOOL_NAMES, ...CATEGORY_ROUTE_TOOL_NAMES, 'get_floor_asset'],
  floor_concrete: [...BASE_ROUTE_TOOL_NAMES, ...CATEGORY_ROUTE_TOOL_NAMES, 'get_floor_asset'],
  floor_stg: [...BASE_ROUTE_TOOL_NAMES, ...CATEGORY_ROUTE_TOOL_NAMES, 'get_floor_asset'],
  floor_vct: [...BASE_ROUTE_TOOL_NAMES, ...CATEGORY_ROUTE_TOOL_NAMES, 'get_floor_asset'],
  // Dilution is always about a NAMED product's ratio/dispenser setup, never about browsing a
  // category; no dilution-route run has called a category tool. B0-529: `get_dispenser_asset` is
  // named in the dilution policy, so it joins this route (rule 3) and no other.
  dilution: [...BASE_ROUTE_TOOL_NAMES, 'get_dispenser_asset'],
  // B0-663 made this route job/problem-driven and its policy names the category tools
  // (`find_products_by_category` / `get_products_in_category` / `get_product_category`) as the way
  // to answer filter-shaped asks — but the route kept the pre-B0-663 cross-reference-only tool
  // set, so the model was told to call tools it did not have and fell through to the cross-
  // reference engine's decline on "what should I use for greasy kitchen floors"-style asks
  // (B0-734, Product Golden run de5bc6c6: 21 recommendations-routed cases averaged 48.8/100).
  recommendations: [...BASE_ROUTE_TOOL_NAMES, ...CATEGORY_ROUTE_TOOL_NAMES],
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
