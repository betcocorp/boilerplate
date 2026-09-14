import type { Tool } from 'openai/resources/responses/responses';

import type { ProductToolName } from '~/lib/tools/tool-schemas';

/**
 * B0-983 — every description below follows one shape so the model compares tools the same way:
 * one sentence on what the tool does and at what grain (one product / a category / a competitor /
 * a knowledge procedure); USE WHEN — the question shapes that belong here; NOT FOR — the
 * neighbouring tool that owns each adjacent shape; RETURNS — the fields to read plus any
 * regulated-data rule. Tool NAMES are stable identifiers (prompts, `RETRIEVAL_TOOL_NAMES`,
 * timeouts, persisted `toolSummary`, the eval harness) and are deliberately unchanged.
 *
 * Size budget: these schemas ride on every model call (B0-437; the prompt cache holds them as
 * part of the static prefix). B0-983 grew the serialized set from ~18k to ~28.5k chars for the
 * disambiguation text — `definitions.test.ts` pins a 30k ceiling so it cannot creep further.
 */

/**
 * B0-364: on the product-fact tools the `productId` parameter is really a product NAME
 * (it is resolved by name, never used as a database id). Models naturally send
 * `productName` instead — the spelling the prose uses — so both keys are accepted and
 * normalized to `productId` by the Zod schemas in `~/lib/tools/tool-schemas`.
 */
const PRODUCT_REF_PARAM = {
  type: 'string',
  description:
    'BETCO product or product-line name or code (e.g. "pH7Q", "AF315", "4020"). Resolved by name, not a database id. Alias: `productName` — send one of the two.',
} as const;

const PRODUCT_NAME_ALIAS_PARAM = {
  type: 'string',
  description: 'Alias for `productId` — send one of the two, not both.',
} as const;

/**
 * B0-547/B0-983 — what a `sources[]` entry from the approved-document retrieval tools is. The
 * previous copy said "a full approved document", contradicting the shared prompt (and the 8k model
 * body cap in `~/lib/tools/model-tool-payload`) inside the same request.
 */
const SOURCES_EXCERPT_NOTE =
  'RETURNS `sources[]` (up to 3) — approved-document EXCERPTS, not whole documents: read the full `documentBody`, cite `documentId` as `[doc:uuid]`; `documentBodyTruncated: true` means more exists — re-query rather than assume a fact is absent.';

const REGULATED_TRANSCRIPTION_RULE =
  'Transcribe ratios, oz/gal, mL/L, ppm, %, contact times, temperatures, EPA/DIN numbers, and log reductions exactly as written — never round, convert, average, or infer.';

/**
 * OpenAI Responses function tools — parameters are JSON Schema objects (strict mode off for flexibility).
 */
export const productSupportTools: Tool[] = [
  {
    type: 'function',
    name: 'search_product_docs',
    strict: false,
    description: [
      'Semantic search over Betco\'s approved product documents (labels, SDS, product-line profiles, knowledge bulletins). The DEFAULT retrieval tool when no more specific tool owns the question.',
      'USE WHEN: any product, label, SDS, feature, or procedure question; a described job with no product named; a follow-up after another tool returned nothing.',
      'HOW: product known → `productName` + `topic` (+ `surfaceType` if named). Product unknown → `freeformQuery` ALONE, `productName` empty.',
      'NOT FOR: dilution ratio, contact time, EPA registration, kill claim → `get_efficacy_data` first; every product in a category → `get_products_in_category`; competitor product → `lookup_cross_reference`; dispenser procedures → `get_dispenser_asset`; floor coat/coverage charts → `get_floor_asset`; non-Betco facts → `web_search`.',
      SOURCES_EXCERPT_NOTE,
      'The "Size and package variants" section (SKUs, inventory IDs, web availability, MSRPs) is collapsed to one line unless `includeVariants: true`.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        productName: {
          type: 'string',
          description: 'The BETCO product name or code when known (e.g. "Green Earth All Purpose", "pH7Q"). Leave empty when using `freeformQuery`.',
        },
        topic: {
          type: 'string',
          description: 'What is being asked about the product (e.g. "dilution", "kill claims", "PPE", "directions for use"). Pair with `productName`; optional with `freeformQuery`.',
        },
        surfaceType: {
          type: 'string',
          description: 'Optional surface the user named (e.g. "VCT", "stainless steel", "grout").',
        },
        freeformQuery: {
          type: 'string',
          description: 'The question in natural language, used INSTEAD OF `productName` + `topic` when the product is unknown (e.g. "best product for mineral scale in toilet bowls").',
        },
        includeVariants: {
          type: 'boolean',
          description: 'Set true ONLY when the question asks about sizes, SKUs, package options, or pricing — returns the full "Size and package variants" section.',
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
    description: [
      'Retrieve technical-specification excerpts (spec sheet, technical data, performance data — pH, coverage, dilution range as printed, form, color, scent) for ONE named Betco product. A fixed spec-focused variant of `search_product_docs`.',
      'USE WHEN: the user asks for a product\'s specs or technical data, or you need to confirm a candidate\'s stated properties before recommending or comparing it.',
      'NOT FOR: verified dilution/contact-time/EPA/kill-claim values → `get_efficacy_data`; hazards, PPE, first aid, storage → `get_safety_constraints`; unknown product or a general question → `search_product_docs`.',
      SOURCES_EXCERPT_NOTE,
    ].join(' '),
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
    description: [
      'Retrieve the label\'s approved directions for use for ONE named Betco product on ONE stated task and surface (e.g. AF315 / "daily damp mopping" / "VCT").',
      'USE WHEN: "how do I use <product> for <task> on <surface>?" and the user actually gave a task AND a surface.',
      '`task` and `surfaceType` are REQUIRED — if either is missing, call `search_product_docs` with `topic: "directions for use"` instead of inventing one.',
      'NOT FOR: the exact dilution figure → `get_efficacy_data`; "is it safe on <surface>?" → `get_compatibility_rules`; dispenser setup → `get_dispenser_asset`.',
      SOURCES_EXCERPT_NOTE,
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        productId: PRODUCT_REF_PARAM,
        productName: PRODUCT_NAME_ALIAS_PARAM,
        task: {
          type: 'string',
          description: 'The cleaning task in the user\'s words (e.g. "daily damp mopping"). Required.',
        },
        surfaceType: {
          type: 'string',
          description: 'The surface the user named (e.g. "VCT", "stainless steel"). Required — do not guess one.',
        },
        environment: {
          type: 'string',
          description: 'Optional facility or setting when stated (e.g. "healthcare", "food service").',
        },
      },
      required: ['task', 'surfaceType'],
    },
  },
  {
    type: 'function',
    name: 'get_safety_constraints',
    strict: false,
    description: [
      'Retrieve safety documentation (SDS and label hazard content: hazard statements, PPE, precautions, first aid, handling and storage conditions, shelf-life figures where printed) for ONE named Betco product.',
      'USE WHEN: "what PPE", "is it hazardous/corrosive/flammable", "what if it gets on skin or in eyes", "how should it be stored", "what is the shelf life", "is it still good after freezing".',
      'NOT FOR: whether it may be used on a surface → `get_compatibility_rules` (named surface) or `list_disallowed_uses` (what it must not touch); dilution, contact time, kill claims → `get_efficacy_data`; the steps for an actual exposure incident → `get_escalation_policy`.',
      SOURCES_EXCERPT_NOTE,
      'Transcribe hazard statements, PPE, and storage temperatures exactly as printed and name the SDS section.',
    ].join(' '),
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
    description: [
      'Answer "can <Betco product> be used on <this specific surface>?" — the label\'s compatibility statements for ONE named product paired with ONE surface the user named (`surfaceType`), optionally narrowed by `materialType`.',
      'USE WHEN: the user named BOTH a product and a specific surface or material and asks whether the pairing is approved.',
      '`surfaceType` is REQUIRED. No surface named → do not invent one; use `list_allowed_surfaces` ("what can I use it on?") or `list_disallowed_uses` ("what must I not use it on?").',
      'NOT FOR: how to apply it → `get_approved_usage_guidance`; hazards or PPE → `get_safety_constraints`.',
      SOURCES_EXCERPT_NOTE,
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        productId: PRODUCT_REF_PARAM,
        productName: PRODUCT_NAME_ALIAS_PARAM,
        surfaceType: {
          type: 'string',
          description: 'The specific surface asked about (e.g. "marble", "LVT"). Required.',
        },
        materialType: {
          type: 'string',
          description: 'Optional material class (e.g. "natural stone", "soft metal").',
        },
      },
      required: ['surfaceType'],
    },
  },
  {
    type: 'function',
    name: 'list_allowed_surfaces',
    strict: false,
    description: [
      'List the surfaces and substrates ONE named Betco product is APPROVED for per its label — the open question "what can I use <product> on?" with no particular surface in mind.',
      'USE WHEN: the user asks which surfaces, materials, or substrates a product is approved or recommended for.',
      'NOT FOR: a specific surface the user named → `get_compatibility_rules`; what it must NOT be used on → `list_disallowed_uses`; step-by-step directions → `get_approved_usage_guidance`.',
      SOURCES_EXCERPT_NOTE,
      'Report only surfaces the excerpt lists; an unlisted surface is "not stated on the label", not "not allowed".',
    ].join(' '),
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
    description: [
      'List the prohibited uses, incompatible surfaces, and "do not use on / do not mix with" warnings printed for ONE named Betco product — "what must I NOT use <product> on or for?".',
      'USE WHEN: the user asks what a product should not be used on, what it damages, or what it must not be mixed with.',
      'NOT FOR: a specific surface the user named → `get_compatibility_rules`; the approved surfaces → `list_allowed_surfaces`; PPE, hazards, first aid, storage → `get_safety_constraints`.',
      SOURCES_EXCERPT_NOTE,
      'Report only prohibitions the excerpt states — never extend a warning to a surface the label does not mention.',
    ].join(' '),
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
    description: [
      'Return Betco\'s INTERNAL escalation checklist (summary + steps) for one of three issue types: safety/exposure/SDS incident, unsettled surface/material compatibility, or the default product-support escalation. Static policy text — reads no product data.',
      'USE WHEN: you have already decided the question must go to a human and need the steps to state.',
      'NOT FOR: any product fact, document, or safety statement → the retrieval tools.',
      'RETURNS `policy` with `summary` and `steps[]`.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        issueType: {
          type: 'string',
          description: 'Free-text issue label. Containing "safety", "exposure", or "sds" → safety policy; "compat", "surface", or "material" → compatibility policy; anything else → default policy.',
        },
      },
      required: ['issueType'],
    },
  },
  {
    type: 'function',
    name: 'get_products_in_category',
    strict: false,
    description: [
      'List every Betco PRODUCT LINE in a website category, each with its item numbers (SKUs). The DEFAULT tool for catalog-list questions.',
      'USE WHEN: "what floor care products do you have?", "show me all disinfectants"; and "best / strongest / most effective X" or "what should I use for X" — Betco data has no cross-product ranking, so the correct answer is the FULL category list, not a single pick.',
      'HOW: `categoryName` may be the exact website category ("Floor Care") or an approximate product-type phrase ("glass cleaner", "degreaser") — matching is tolerant. Set `categoryLevel` only to pin one hierarchy level.',
      'Product lines are the grain labels and `get_efficacy_data` use — pass the same `categoryName` as `get_efficacy_data` `category` for verified facts across the list in ONE call. Zero products → retry with `find_products_by_category` (a stricter resolver that knows some shopper phrasings) before calling the category empty.',
      'NOT FOR: one named product → `get_product_category` or `search_product_docs`; a competitor product → `lookup_cross_reference`; the web-catalog SKU listing → `find_products_by_category`.',
      'RETURNS `products[]` (productLineName, category values per level, `items[]` item numbers) and `totalFound`.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        categoryName: {
          type: 'string',
          description: 'Website category name or product-type phrase (e.g. "Floor Care", "Deodorizers", "glass cleaner", "degreaser"). Tolerant, case-insensitive match.',
        },
        categoryLevel: {
          type: 'string',
          enum: ['prod_type', 'sub_prod_type', 'sub_child_prod_type', 'prod_class', 'any'],
          description: 'Hierarchy level to match against. Defaults to "any"; set only when the user named that level.',
        },
        maxResults: {
          type: 'number',
          description: 'Max product lines to return (default 20, max 50). `totalFound` still reports the full count.',
        },
      },
      required: ['categoryName'],
    },
  },
  {
    type: 'function',
    name: 'get_product_category',
    strict: false,
    description: [
      'Look up which website category ONE named Betco product belongs to — the reverse of `get_products_in_category`. Returns the category chain (prod_type → sub_prod_type → sub_child_prod_type) and prod_class for its product line.',
      'USE WHEN: the user asks what category or type a product is; or as step one of "what is similar to / an alternative to <Betco product>" — pass the returned category to `get_products_in_category` to list its siblings.',
      'NOT FOR: listing products directly → `get_products_in_category`; a product\'s own facts → `search_product_docs`, `get_efficacy_data`; a competitor product → `lookup_cross_reference`.',
      'Accepts the product name or code as `productId` (or `productName`).',
      'RETURNS `productLineName` and `category` (`hasCategory: false`, `category: null` when the profile carries none).',
    ].join(' '),
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
    name: 'find_products_by_category',
    strict: false,
    description: [
      'Resolve a product-type phrase to ONE node of the betco.com taxonomy and return the sellable WEB CATALOG items under it (SKU, title, short description, web status). Deterministic — no semantic search.',
      'USE WHEN: the user wants the web-catalog listing for a product type ("which floor strippers are on your website?"), or as the fallback after `get_products_in_category` returned zero products. Otherwise `get_products_in_category` is the default list tool (product LINES with item numbers).',
      'Strict confidence gate: no confident match → `path: "semantic"` with `reason` and `topCandidate`; then call `get_products_in_category` or `search_product_docs` — do not retry with rewordings.',
      '`url` is DERIVED from legacy catalog fields and not verified to resolve — do not present it as a confirmed link.',
      'NOT FOR: a named Betco product → `get_product_category`; a competitor product → `lookup_cross_reference`.',
      'RETURNS `path: "category"` with `node`, `confidence`, `productCount`, `products[]`.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The product-type phrase in the user\'s words (e.g. "floor strippers", "glass cleaner", "warewashing detergents"). Not a product name.',
        },
        maxResults: {
          type: 'number',
          description: 'Max web products to return (default 25, max 50). `productCount` still reports the full count.',
        },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'lookup_cross_reference',
    strict: false,
    description: [
      'Look up a COMPETITOR product in Betco\'s cross-reference tables and return the Betco equivalent(s). Step ONE of every competitor cross-reference.',
      'Both parameters describe the COMPETITOR, not a Betco product: `brand` = competitor manufacturer ("Spartan", "Diversey"), `productName` = the competitor\'s product ("#1 Laundry Break", "Virex II 256").',
      'USE WHEN: the user asks for Betco\'s equivalent to or replacement for a named competitor product — call this FIRST, before any other search.',
      'Both fields are REQUIRED and non-empty — never send empty strings. Competitor product named but no brand → `recommend_cross_reference` instead (brand optional there). No competitor product named → this tool does not apply.',
      'NOT FOR: Betco-to-Betco alternatives → `get_product_category` then `get_products_in_category`; Betco product facts → `search_product_docs`.',
      'RETURNS `matches[]` (Betco equivalents with confidence) and `fallbackRecommended`. Empty `matches` or `fallbackRecommended: true` → call `recommend_cross_reference` next.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        brand: {
          type: 'string',
          description: 'The COMPETITOR manufacturer or brand (e.g. "Spartan", "Diversey"). Required, non-empty. Never "Betco".',
        },
        productName: {
          type: 'string',
          description: 'The COMPETITOR\'s product name (e.g. "#1 Laundry Break"). Required, non-empty. Here `productName` is NOT a Betco product.',
        },
        maxResults: {
          type: 'number',
          description: 'Optional max number of Betco matches (default 3, max 10).',
        },
      },
      required: ['brand', 'productName'],
    },
  },
  {
    type: 'function',
    name: 'recommend_cross_reference',
    strict: false,
    description: [
      'Web-grounded competitor cross-reference — step TWO, only when the cross-reference tables could not answer. Researches the competitor product via web search, extracts its spec, and recommends the closest Betco equivalent(s) with `overallConfidence` and `evidence`.',
      'USE WHEN: `lookup_cross_reference` returned empty `matches` or `fallbackRecommended: true`; or the user named a competitor product but no brand, so `lookup_cross_reference` cannot be called.',
      '`competitorProduct` = the COMPETITOR\'s product (required); `competitorBrand` = its manufacturer when known (optional, improves confidence).',
      'RETURNS `answered: true` with `candidates[]`, or a decline (`answered: false`, `declineReason`). Treat `answered`, `declineReason`, and `overallConfidence` as authoritative: relay a decline verbatim and NEVER invent a Betco product, SKU, or claim.',
      'NOT FOR: a competitor not yet looked up when brand and product are both known → `lookup_cross_reference` first; Betco product facts → `search_product_docs`; general research → `web_search`.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        competitorProduct: {
          type: 'string',
          description: 'The COMPETITOR\'s product name (required), e.g. "BNC-15", "Virex II 256".',
        },
        competitorBrand: {
          type: 'string',
          description: 'The competitor manufacturer or brand when known (optional, improves confidence), e.g. "Spartan".',
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
    description: [
      'Return VERIFIED structured facts for a Betco product from the fact tables — dilution (oz/gal), contact/dwell time, EPA registration, per-organism kill claims — plus, when on file, the authoritative lab-report citation (formula, version, lab, Project #, raw PDF S3 source). An EXACT lookup of typed columns, not a paraphrase of prose; runs no semantic search.',
      'USE WHEN: any dilution-ratio question, and any efficacy / "what does it kill" / kill-claim / log-reduction / contact-time / EPA-registration question — call it FIRST, before `search_product_docs`.',
      'SINGLE PRODUCT: `productId` (or `productName`), plus `organism` to filter kill claims. BATCH: for MORE THAN ONE product in the same turn (a comparison, a whole category, "which of these kill X") do NOT call once per product — send `productIds` (array of names/codes) or `category` (website category, resolved like `get_products_in_category`); the batch response returns `results[]` (one entry per product, each shaped like the single-product response) instead of top-level `facts`/`labReport`.',
      'NOT FOR: how to apply the product → `get_approved_usage_guidance`; dispenser or ratio-calculation procedures → `get_dispenser_asset`; hazards or PPE → `get_safety_constraints`.',
      'RETURNS `facts` and/or `labReport` plus `sources[]`. Each fact row carries its own `confidence` (1.0 = source of record; below 1.0 → say it is less certain). `resolvedProductTitle` is the product the data actually belongs to — if it differs from what you asked for, tell the user. Cite the lab report\'s `documentId` as `[doc:uuid]`, naming the specific formula/version that generated the numbers even if a newer formula reuses them.',
      'A lab-report excerpt may hold several organisms or product/formula/version blocks: cite ONLY the row and table naming the exact product/formula/version asked about — never a sibling block. A "No Reduction" / "NR" / blank log-reduction cell is NEVER a positive kill claim: state the absence exactly as printed or decline — never invert it into "yes, it reduced X" (B0-802).',
      '`fastDrawDilution` (nullable, single-product form only) holds FastDraw-dispenser-specific dilution/yield figures, kept as its OWN field because for some products it legitimately differs from `facts.dilutionDisplay` (general use vs. the FastDraw dispenser). Answer with whichever field the question is about; never blend the two into one number.',
      '`facts: null` and `labReport: null` plus a `note` means NEITHER is on file — do NOT estimate or infer; after the `search_product_docs` follow-up the shared rules require, tell the user the verified value is not on file.',
      REGULATED_TRANSCRIPTION_RULE,
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        productId: PRODUCT_REF_PARAM,
        productName: PRODUCT_NAME_ALIAS_PARAM,
        productIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'BATCH FORM: Betco product names/codes to fetch in ONE call. Use exactly one of `productId`/`productName`, `productIds`, `category`.',
        },
        category: {
          type: 'string',
          description: 'BATCH FORM: every product line in this website category (e.g. "Disinfectants") in ONE call; same matching as `get_products_in_category`.',
        },
        categoryLevel: {
          type: 'string',
          enum: ['prod_type', 'sub_prod_type', 'sub_child_prod_type', 'prod_class', 'any'],
          description: 'Only with `category` — which hierarchy level to match. Defaults to "any".',
        },
        organism: {
          type: 'string',
          description: 'Optional organism or pathogen to filter kill claims to (e.g. "Norovirus", "C. difficile"). Omit for every claim on file.',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'get_dispenser_asset',
    strict: false,
    description: [
      'Retrieve Betco DISPENSER and dilution-control PROCEDURE documents from the approved knowledge corpus — proportioner/dispenser setup, metering-tip selection, calibration, installation, maintenance, troubleshooting, backflow, and dilution-ratio calculation guides.',
      'USE WHEN: "how is the <dispenser> set up", "which metering tip", "how do I calibrate it", "how do I calculate the ratio from a tip", "how do I install/troubleshoot it" — answers that are a documented PROCEDURE, not a per-product fact.',
      'NOT FOR: a product\'s verified dilution ratio → `get_efficacy_data` (this returns procedure text, not the fact tables); floor charts → `get_floor_asset`; label directions → `search_product_docs`.',
      'Send at least one of `dispenserModel`, `productName`, `topic`. Not anchored to a product line — a product name is only query text.',
      'RETURNS up to 5 knowledge documents in `sources[].documentBody`; cite `documentId` as `[doc:uuid]`. Transcribe any ratio, oz/gal, mL/L, dwell time, or standard number exactly as written.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        dispenserModel: {
          type: 'string',
          description: 'Dispenser, proportioner, or dilution-control system name/model when the user named one (e.g. "FastDraw", "Clario").',
        },
        productName: {
          type: 'string',
          description: 'The BETCO product the dispenser is set up for, when known. Query text only.',
        },
        topic: {
          type: 'string',
          description: 'The procedure asked for, e.g. "metering tip selection", "calibration", "dilution ratio chart", "installation", "troubleshooting".',
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
    description: [
      'Retrieve Betco FLOOR-CARE PROCEDURE documents from the approved knowledge corpus — coat-count and coverage/yield charts, finish application and dry/cure guidance, top-scrub and recoat, stripping, burnishing, and pad/equipment guides.',
      'USE WHEN: "how many coats", "what coverage per gallon", "how long between coats", "what is the top-scrub and recoat procedure", "how do I strip this floor" — on a named floor surface (VCT, terrazzo, sealed concrete, hardwood, sport floor).',
      'NOT FOR: a product\'s verified dilution ratio or contact time → `get_efficacy_data`; dispenser setup → `get_dispenser_asset`; label directions or SDS → `search_product_docs`; which finish products exist → `get_products_in_category`.',
      'Send at least one of `surfaceType`, `productName`, `procedure`. Not anchored to a product line — a product name is only query text.',
      'RETURNS up to 5 knowledge documents in `sources[].documentBody`; cite `documentId` as `[doc:uuid]`. Transcribe coat counts, coverage figures, dry times, and dilution values exactly as written — never round, convert, or average them.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        surfaceType: {
          type: 'string',
          description: 'Floor surface named by the user, e.g. "VCT", "terrazzo", "sealed concrete", "hardwood", "gym floor".',
        },
        productName: {
          type: 'string',
          description: 'The Betco or Basic Coatings product when the question names one. Query text only.',
        },
        procedure: {
          type: 'string',
          description: 'Procedure or chart wanted, e.g. "coat count", "coverage yield", "top scrub recoat", "stripping", "burnishing", "dry time between coats".',
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
    description: [
      'General-purpose live web search. NOT a Betco data source — nothing it returns is an approved document.',
      'USE WHEN: the fact cannot be on file at Betco — confirming a competitor company or product\'s identity, regulatory-body or industry background (EPA, Health Canada, ASSE, OSHA), or other current external information the user asked about.',
      'NOT FOR: any Betco product fact — dilution ratio, EPA/DIN registration, kill claim, contact time, SDS/PPE, spec, compatibility — those come only from the approved-document tools; a web result is never a substitute for the approved corpus and must never be cited as one. Competitor-to-Betco matching → `lookup_cross_reference` then `recommend_cross_reference`.',
      'RETURNS `results[]` (title, url, snippet, score) plus `answer` and `metrics`. Start with `depth: "basic"`; use "advanced" only when basic came back thin.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The web search query.',
        },
        depth: {
          type: 'string',
          enum: ['basic', 'advanced'],
          description: 'Search depth. Defaults to "basic"; use "advanced" only when basic was insufficient.',
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional domain allowlist (e.g. ["epa.gov"]).',
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
