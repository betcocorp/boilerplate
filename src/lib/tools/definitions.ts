import type { Tool } from 'openai/resources/responses/responses';

/**
 * OpenAI Responses function tools — parameters are JSON Schema objects (strict mode off for flexibility).
 */
export const productSupportTools: Tool[] = [
  {
    type: 'function',
    name: 'search_product_docs',
    strict: false,
    description:
      'Search Betco product documentation (RAG). Use for general product + topic questions. Returns up to 3 sources where each source is a full approved document (read `documentBody`, not just `snippet`). Pass `freeformQuery` (and leave `productName` empty) when the product name is unknown.',
    parameters: {
      type: 'object',
      properties: {
        productName: {
          type: 'string',
          description: 'Specific Betco product name when known (e.g. "Green Earth All Purpose"). Leave empty when using freeformQuery.',
        },
        topic: { type: 'string', description: 'Topic or question type (e.g. "dilution", "kill claims", "PPE").' },
        surfaceType: {
          type: 'string',
          description: 'Optional surface context.',
        },
        freeformQuery: {
          type: 'string',
          description: 'Use instead of productName for broad searches where the product is not yet known (e.g. "best product for removing mineral scale from toilet bowls").',
        },
      },
      required: ['topic'],
    },
  },
  {
    type: 'function',
    name: 'get_product_spec',
    strict: false,
    description:
      'Retrieve spec-oriented excerpts for a product id or product key string.',
    parameters: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
      },
      required: ['productId'],
    },
  },
  {
    type: 'function',
    name: 'get_approved_usage_guidance',
    strict: false,
    description:
      'Retrieve approved usage / procedure documentation for a product on a given task and surface. Returns up to 3 full approved documents in `sources[].documentBody`.',
    parameters: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
        task: { type: 'string' },
        surfaceType: { type: 'string' },
        environment: { type: 'string' },
      },
      required: ['productId', 'task', 'surfaceType'],
    },
  },
  {
    type: 'function',
    name: 'get_safety_constraints',
    strict: false,
    description:
      'Retrieve safety / SDS-oriented documentation (PPE, hazards, precautions). Returns up to 3 full approved documents in `sources[].documentBody`.',
    parameters: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
      },
      required: ['productId'],
    },
  },
  {
    type: 'function',
    name: 'get_compatibility_rules',
    strict: false,
    description:
      'Retrieve compatibility guidance for product + surface (+ optional material).',
    parameters: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
        surfaceType: { type: 'string' },
        materialType: { type: 'string' },
      },
      required: ['productId', 'surfaceType'],
    },
  },
  {
    type: 'function',
    name: 'list_allowed_surfaces',
    strict: false,
    description:
      'Find documentation excerpts that describe allowed / compatible surfaces.',
    parameters: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
      },
      required: ['productId'],
    },
  },
  {
    type: 'function',
    name: 'list_disallowed_uses',
    strict: false,
    description:
      'Find documentation excerpts about prohibited uses, incompatibility, or warnings.',
    parameters: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
      },
      required: ['productId'],
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
];
