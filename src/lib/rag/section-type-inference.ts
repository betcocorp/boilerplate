/**
 * Infers GHS section type from a query string using high-confidence keyword patterns.
 * Only returns a non-null value when the query clearly targets a single section;
 * broad or multi-section queries return null so retrieval stays unfiltered.
 *
 * Ordered from most specific to least to avoid false matches on overlapping terms.
 */
const QUERY_PATTERNS: Array<{ pattern: RegExp; sectionType: string }> = [
  // Section 4 — First Aid
  {
    pattern: /\b(first aid|if swallowed|if ingested|if inhaled|if in eyes|skin contact|eye contact)\b/i,
    sectionType: 'first_aid',
  },
  // Section 6 — Spill/Release
  {
    pattern: /\b(spill|accidental release|clean up a leak|contain the release)\b/i,
    sectionType: 'spill_response',
  },
  // Section 13 — Disposal
  {
    pattern: /\b(dispos(e|al|ing)|how to get rid of|waste disposal|discard)\b/i,
    sectionType: 'disposal',
  },
  // Section 14 — Transport
  {
    pattern: /\b(transport|shipping classification|un number|dot class|iata|imdg|packing group)\b/i,
    sectionType: 'transport',
  },
  // Section 5 — Fire Fighting
  {
    pattern: /\b(fire fighting|extinguish|firefighter|flammable|combustible|flash point)\b/i,
    sectionType: 'fire_fighting',
  },
  // Section 15 — Regulatory
  {
    pattern: /\b(epa reg(istration)?|prop(osition)? 65|sara|cercla|regulatory information)\b/i,
    sectionType: 'regulatory',
  },
  // Section 11 — Toxicology
  {
    pattern: /\b(ld50|lc50|toxicolog(y|ical)|carcinogen|mutagen(ic)?|reproductive toxicity)\b/i,
    sectionType: 'toxicology',
  },
  // Section 12 — Ecological
  {
    pattern: /\b(ecolog(y|ical)|aquatic toxicity|bioaccumulation|persistence|environmental fate)\b/i,
    sectionType: 'ecological',
  },
  // Section 8 — Exposure / PPE
  {
    pattern: /\b(ppe|personal protective|gloves|goggles|respirator|exposure limit|osha pel|acgih tlv|ventilation requirement)\b/i,
    sectionType: 'exposure_ppe',
  },
  // Section 9 — Physical Properties
  {
    pattern: /\b(boiling point|vapor pressure|specific gravity|viscosity|solubility|appearance and odor|physical (and chemical )?propert)\b/i,
    sectionType: 'physical_properties',
  },
  // Section 3 — Composition
  {
    pattern: /\b(cas number|ingredient(s)?|composition|chemical formula|percent by weight|mixture component)\b/i,
    sectionType: 'composition',
  },
  // Section 10 — Stability
  {
    pattern: /\b(stability|reactivity|incompatible material|hazardous decomposition|polymeriz)\b/i,
    sectionType: 'stability',
  },
  // Section 7 — Handling/Storage (lower priority — broad terms)
  {
    pattern: /\b(storage condition|how to store|shelf life|keep away from|safe handling)\b/i,
    sectionType: 'handling_storage',
  },
  // Section 2 — Hazard (lowest priority — very broad)
  {
    pattern: /\b(hazard classification|ghs signal|signal word|h-statement|hazard statement|pictogram)\b/i,
    sectionType: 'hazard',
  },
];

/**
 * Returns the most likely GHS section type for a query, or null if the query
 * is too broad or ambiguous to confidently target a single section.
 */
export function inferSectionTypeFromQuery(query: string): string | null {
  const text = query.toLowerCase();
  for (const { pattern, sectionType } of QUERY_PATTERNS) {
    if (pattern.test(text)) {
      return sectionType;
    }
  }
  return null;
}

/**
 * Fixed section type mappings for product tools whose query templates are
 * known to target a specific GHS section.
 */
export function inferSectionTypeFromToolName(
  toolName: string,
): string | null {
  switch (toolName) {
    case 'get_approved_usage_guidance':
    case 'list_allowed_surfaces':
    case 'list_disallowed_uses':
    case 'get_compatibility_rules':
      return 'handling_storage';

    // Safety constraints spans multiple sections (hazard + exposure + first aid);
    // product spec and general search should not be filtered.
    default:
      return null;
  }
}
