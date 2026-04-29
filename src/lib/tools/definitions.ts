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
      'Search Betco product documentation (RAG). Use for general product + topic questions. Returns up to 3 sources where each source is a full approved document (read `documentBody`, not just `snippet`).',
    parameters: {
      type: 'object',
      properties: {
        productName: { type: 'string' },
        topic: { type: 'string' },
        surfaceType: {
          type: 'string',
          description: 'Optional surface context.',
        },
      },
      required: ['productName', 'topic'],
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
