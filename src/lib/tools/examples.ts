/**
 * Example data and defaults for each product-support tool.
 * Used in the admin tools documentation UI for interactive testing.
 */

export const TOOL_EXAMPLES: Record<string, Record<string, unknown>> = {
  search_product_docs: {
    productName: 'pH7Q',
    topic: 'dilution',
    surfaceType: 'restroom',
    freeformQuery: '',
    includeVariants: false,
  },
  get_product_spec: {
    productId: 'pH7Q',
    productName: '',
  },
  get_approved_usage_guidance: {
    productId: 'AF315',
    productName: '',
    task: 'floor cleaning',
    surfaceType: 'vinyl',
    environment: 'commercial',
  },
  get_safety_constraints: {
    productId: 'pH7Q',
    productName: '',
  },
  get_compatibility_rules: {
    productId: 'AF315',
    productName: '',
    surfaceType: 'marble',
    materialType: 'stone',
  },
  list_allowed_surfaces: {
    productId: 'Green Earth All Purpose',
    productName: '',
  },
  list_disallowed_uses: {
    productId: 'pH7Q',
    productName: '',
  },
  get_escalation_policy: {
    issueType: 'product_safety',
  },
  get_products_in_category: {
    categoryName: 'Floor Care',
    categoryLevel: 'any',
    maxResults: 20,
  },
  get_product_category: {
    productId: 'pH7Q',
    productName: '',
  },
  find_products_by_category: {
    query: 'disinfectants',
    maxResults: 25,
  },
  lookup_cross_reference: {
    brand: 'Spartan',
    productName: '#1 Laundry Break',
    maxResults: 3,
  },
  recommend_cross_reference: {
    competitorProduct: 'BNC-15',
    competitorBrand: 'Spartan',
    maxResults: 5,
  },
  get_efficacy_data: {
    productId: 'pH7Q',
    productName: '',
  },
  get_dispenser_asset: {
    dispenserModel: '',
    productName: '',
    topic: 'calculating dilution ratios',
    maxResults: 3,
  },
  get_floor_asset: {
    surfaceType: 'VCT',
    productName: '',
    procedure: 'coat count',
    maxResults: 3,
  },
  web_search: {
    query: 'Spartan Chemical Company headquarters',
    depth: 'basic',
    domains: [],
    maxResults: 5,
  },
  // B0-528 — running this from the admin tool runner creates a REAL escalation row when the
  // BEX_ESCALATION_TOOL_ENABLED flag is on (and a "disabled" result when it is off).
  escalation_specialist: {
    reason: 'no_evidence',
    summary:
      'Admin tool-runner test: the user asked for the contact time of a product with no label on file; search_product_docs and get_efficacy_data returned nothing.',
    question: 'What is the contact time for product X on stainless steel?',
    specialist: 'product',
    retrievedSources: [],
  },
};

export function getToolExample(toolName: string): Record<string, unknown> {
  return TOOL_EXAMPLES[toolName] || {};
}
