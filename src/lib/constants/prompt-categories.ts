export type PromptCategoryGroup =
  | 'product-discovery'
  | 'safety-regulatory'
  | 'application-chemistry'
  | 'procedures-programs'
  | 'market-context'
  | 'logistics-support'
  | 'test-integrity';

export type PromptCategory = {
  slug: string;
  label: string;
  group: PromptCategoryGroup;
  /** One-line description of the question type. */
  description: string;
  /** True if this tag was observed in the actual test_items dataset. */
  inDataset: boolean;
};

export const PROMPT_CATEGORIES = [
  // ── Product Discovery ────────────────────────────────────────────────────
  {
    slug: 'recommendation',
    label: 'Recommendation',
    group: 'product-discovery',
    description: '"What should I use for X?" — single-product pick',
    inDataset: true,
  },
  {
    slug: 'product-comparison',
    label: 'Product Comparison',
    group: 'product-discovery',
    description: 'Two or more Betco products compared',
    inDataset: true,
  },
  {
    slug: 'product-type',
    label: 'Product Type',
    group: 'product-discovery',
    description: '"What kind of product is X?" — classification',
    inDataset: true,
  },
  {
    slug: 'product-line-overview',
    label: 'Product Line Overview',
    group: 'product-discovery',
    description: '"What does Betco make for X category?" — portfolio survey',
    inDataset: false,
  },
  {
    slug: 'competitor',
    label: 'Competitor',
    group: 'product-discovery',
    description: 'Competitor replacement or cross-reference',
    inDataset: true,
  },
  {
    slug: 'new-product',
    label: 'New Product',
    group: 'product-discovery',
    description: 'Recently launched or reformulated products',
    inDataset: false,
  },
  {
    slug: 'negative-knowledge',
    label: 'Negative Knowledge',
    group: 'product-discovery',
    description: '"Does Betco make something that does X?" where the answer is no',
    inDataset: false,
  },

  // ── Safety & Regulatory ──────────────────────────────────────────────────
  {
    slug: 'safety-ppe',
    label: 'Safety & PPE',
    group: 'safety-regulatory',
    description: 'PPE requirements and safe handling',
    inDataset: true,
  },
  {
    slug: 'sds-hazard',
    label: 'SDS Hazard',
    group: 'safety-regulatory',
    description: 'SDS hazard section information',
    inDataset: true,
  },
  {
    slug: 'first-aid',
    label: 'First Aid',
    group: 'safety-regulatory',
    description: 'Exposure and first aid procedures',
    inDataset: true,
  },
  {
    slug: 'mixing-compatibility',
    label: 'Mixing Compatibility',
    group: 'safety-regulatory',
    description: 'Chemical compatibility, what not to combine',
    inDataset: true,
  },
  {
    slug: 'disposal-environmental',
    label: 'Disposal & Environmental',
    group: 'safety-regulatory',
    description: 'Disposal methods and environmental impact',
    inDataset: true,
  },
  {
    slug: 'storage-shelf-life',
    label: 'Storage & Shelf Life',
    group: 'safety-regulatory',
    description: 'Storage conditions and shelf life',
    inDataset: true,
  },
  {
    slug: 'kill-claims',
    label: 'Kill Claims',
    group: 'safety-regulatory',
    description: 'Efficacy and pathogen kill claims',
    inDataset: true,
  },
  {
    slug: 'epa-certifications',
    label: 'EPA Certifications',
    group: 'safety-regulatory',
    description: 'EPA registration numbers, DfE, Safer Choice',
    inDataset: true,
  },
  {
    slug: 'green-certifications',
    label: 'Green Certifications',
    group: 'safety-regulatory',
    description: 'LEED, UL ECOLOGO, Green Seal — sustainability credentials',
    inDataset: false,
  },
  {
    slug: 'food-safety',
    label: 'Food Safety',
    group: 'safety-regulatory',
    description: 'NSF/ANSI 2, food-contact surfaces, no-rinse requirements',
    inDataset: false,
  },
  {
    slug: 'healthcare-compliance',
    label: 'Healthcare Compliance',
    group: 'safety-regulatory',
    description: 'CDC guidelines, hospital-grade, bloodborne pathogen standard',
    inDataset: false,
  },
  {
    slug: 'state-regulations',
    label: 'State Regulations',
    group: 'safety-regulatory',
    description: 'Prop 65, CARB VOC limits, state-specific pesticide registration',
    inDataset: false,
  },

  // ── Application & Chemistry ──────────────────────────────────────────────
  {
    slug: 'dilution',
    label: 'Dilution',
    group: 'application-chemistry',
    description: 'Dilution ratios, RTU vs. concentrate',
    inDataset: true,
  },
  {
    slug: 'dispensing-systems',
    label: 'Dispensing Systems',
    group: 'application-chemistry',
    description: 'ProGuard, dispenser hardware, metering tips, installation',
    inDataset: false,
  },
  {
    slug: 'dwell-time',
    label: 'Dwell Time',
    group: 'application-chemistry',
    description: 'Contact time requirements for efficacy',
    inDataset: true,
  },
  {
    slug: 'reapplication-frequency',
    label: 'Reapplication Frequency',
    group: 'application-chemistry',
    description: 'How often to retreat a surface (distinct from single-application dwell time)',
    inDataset: false,
  },
  {
    slug: 'surface-compatibility',
    label: 'Surface Compatibility',
    group: 'application-chemistry',
    description: 'Safe surfaces for a given product, including porous vs. non-porous distinctions',
    inDataset: true,
  },
  {
    slug: 'pathogen-specific',
    label: 'Pathogen Specific',
    group: 'application-chemistry',
    description: 'Questions targeting a specific pathogen or organism',
    inDataset: true,
  },
  {
    slug: 'water-quality',
    label: 'Water Quality',
    group: 'application-chemistry',
    description: 'Hard water and mineral content effects on quat efficacy',
    inDataset: false,
  },
  {
    slug: 'temperature-sensitivity',
    label: 'Temperature Sensitivity',
    group: 'application-chemistry',
    description: 'Efficacy at cold/hot temperatures, freeze tolerance',
    inDataset: false,
  },

  // ── Procedures & Programs ────────────────────────────────────────────────
  {
    slug: 'restroom-procedure',
    label: 'Restroom Procedure',
    group: 'procedures-programs',
    description: 'Restroom cleaning and disinfection workflows',
    inDataset: true,
  },
  {
    slug: 'floor-care',
    label: 'Floor Care',
    group: 'procedures-programs',
    description: 'Stripping, finishing, burnishing, recoating programs',
    inDataset: true,
  },
  {
    slug: 'carpet-care',
    label: 'Carpet Care',
    group: 'procedures-programs',
    description: 'Carpet extraction, spot treatment, and deodorization',
    inDataset: false,
  },
  {
    slug: 'odor-control',
    label: 'Odor Control',
    group: 'procedures-programs',
    description: 'Odor neutralization products and methods',
    inDataset: true,
  },
  {
    slug: 'drain-treatment',
    label: 'Drain Treatment',
    group: 'procedures-programs',
    description: 'Biological drain gels and drain maintenance programs',
    inDataset: false,
  },
  {
    slug: 'multi-product-workflow',
    label: 'Multi-Product Workflow',
    group: 'procedures-programs',
    description: 'Multi-step, cross-product procedures (e.g. strip → seal → finish)',
    inDataset: false,
  },

  // ── Market Segments & Context ────────────────────────────────────────────
  {
    slug: 'facility-type',
    label: 'Facility Type',
    group: 'market-context',
    description: 'Healthcare, education, food service, and other vertical markets',
    inDataset: true,
  },
  {
    slug: 'hand-hygiene',
    label: 'Hand Hygiene',
    group: 'market-context',
    description: 'Soaps, sanitizers, skin care, and hygiene dispensers',
    inDataset: false,
  },
  {
    slug: 'laundry',
    label: 'Laundry',
    group: 'market-context',
    description: 'Commercial laundry products and programs',
    inDataset: false,
  },
  {
    slug: 'equipment-compatibility',
    label: 'Equipment Compatibility',
    group: 'market-context',
    description: 'Auto scrubbers, burnishers, pressure washers, microfiber compatibility',
    inDataset: false,
  },

  // ── Logistics & Support ──────────────────────────────────────────────────
  {
    slug: 'packaging',
    label: 'Packaging',
    group: 'logistics-support',
    description: 'Sizes, formats, SKUs, and unit counts',
    inDataset: true,
  },
  {
    slug: 'pricing-availability',
    label: 'Pricing & Availability',
    group: 'logistics-support',
    description: 'Ordering, minimums, regional availability, discontinued products',
    inDataset: false,
  },
  {
    slug: 'training-resources',
    label: 'Training Resources',
    group: 'logistics-support',
    description: 'Sell sheets, SDS binder requirements, distributor certification programs',
    inDataset: false,
  },

  // ── Test Integrity & Edge Cases ──────────────────────────────────────────
  {
    slug: 'out-of-scope',
    label: 'Out of Scope',
    group: 'test-integrity',
    description: 'Non-Betco topics that should trigger the scope gate',
    inDataset: true,
  },
  {
    slug: 'ambiguous-product-name',
    label: 'Ambiguous Product Name',
    group: 'test-integrity',
    description: 'Informal names, misspellings, or partial names — entity resolution stress test',
    inDataset: false,
  },
  {
    slug: 'version-conflict',
    label: 'Version Conflict',
    group: 'test-integrity',
    description: 'Discontinued, renamed, or reformulated products — stale corpus detection',
    inDataset: false,
  },
] as const satisfies PromptCategory[];

export type PromptCategorySlug = (typeof PROMPT_CATEGORIES)[number]['slug'];

export const PROMPT_CATEGORY_SLUGS = PROMPT_CATEGORIES.map((c) => c.slug) as PromptCategorySlug[];

export const PROMPT_CATEGORY_BY_SLUG = Object.fromEntries(
  PROMPT_CATEGORIES.map((c) => [c.slug, c]),
) as Record<PromptCategorySlug, PromptCategory>;

// ── Group metadata (shared by server pages and client components) ─────────

export const PROMPT_CATEGORY_GROUP_LABELS: Record<PromptCategoryGroup, string> = {
  'product-discovery':    'Product Discovery',
  'safety-regulatory':    'Safety & Regulatory',
  'application-chemistry':'Application & Chemistry',
  'procedures-programs':  'Procedures & Programs',
  'market-context':       'Market Context',
  'logistics-support':    'Logistics & Support',
  'test-integrity':       'Test Integrity',
};

/** Tailwind bg-* class for each group's accent dot. */
export const PROMPT_CATEGORY_GROUP_COLORS: Record<PromptCategoryGroup, string> = {
  'product-discovery':    'bg-sky-400',
  'safety-regulatory':    'bg-amber-400',
  'application-chemistry':'bg-emerald-400',
  'procedures-programs':  'bg-violet-400',
  'market-context':       'bg-teal-400',
  'logistics-support':    'bg-slate-400',
  'test-integrity':       'bg-rose-400',
};

export const PROMPT_CATEGORY_GROUP_ORDER: PromptCategoryGroup[] = [
  'product-discovery',
  'safety-regulatory',
  'application-chemistry',
  'procedures-programs',
  'market-context',
  'logistics-support',
  'test-integrity',
];

/** Categories pre-grouped and ordered — safe to use in both server and client. */
export const PROMPT_CATEGORIES_BY_GROUP = PROMPT_CATEGORY_GROUP_ORDER.map((group) => ({
  group,
  label: PROMPT_CATEGORY_GROUP_LABELS[group],
  color: PROMPT_CATEGORY_GROUP_COLORS[group],
  items: PROMPT_CATEGORIES.filter((c) => c.group === group),
}));
