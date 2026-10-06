export type PassageIntent = {
  key: string;
  sdsSectionTypes: string[];
  labelSectionTypes: string[];
};

const SDS_SECTION_TYPES_BY_INTENT: Record<string, string[]> = {
  exposure_ppe: ['hazard', 'exposure_ppe'],
};

const LABEL_SECTION_TYPES_BY_SDS_SECTION: Record<string, string[]> = {
  organism_contact_time: ['directions', 'dilution', 'epa_claims'],
  virucidal_activity: ['directions', 'epa_claims'],
  fungistatic: ['directions', 'epa_claims'],
  bactericidal_efficacy: ['directions', 'epa_claims'],
  first_aid: ['first_aid'],
  hazard: ['hazards', 'directions'],
  handling_storage: ['surfaces', 'storage_disposal', 'directions'],
  regulatory: ['epa_claims'],
  exposure_ppe: ['directions', 'hazards'],
  spill_response: ['directions'],
  disposal: ['storage_disposal'],
};

const SOFT_SURFACE_PATTERN =
  /\b(soft[ -]?surface|upholster(?:y|ed)|curtains?|wrestling mats?|fabric(?:s)?|textiles?|sanitize\w*.{0,40}surface)\b/i;

/**
 * Maps one query intent to document-specific section selectors. SDS chunks carry fine-grained
 * `section_type` values directly. Label chunks keep a coarse database type (`label`) and expose
 * their fine-grained section in the heading marker emitted by the label converter.
 */
export function passageSectionTypesForDocument(
  intent: PassageIntent,
  documentKind: string,
): string[] {
  const normalizedKind = documentKind.trim().toLowerCase();
  if (normalizedKind === 'sds') return intent.sdsSectionTypes;
  if (normalizedKind === 'label') return intent.labelSectionTypes;
  return [];
}

export function resolvePassageIntent(
  query: string,
  inferredSdsSectionType: string | null | undefined,
): PassageIntent | null {
  if (SOFT_SURFACE_PATTERN.test(query)) {
    return {
      key: 'soft_surface_sanitization',
      sdsSectionTypes: [],
      labelSectionTypes: ['surfaces', 'directions'],
    };
  }

  const sectionType = inferredSdsSectionType?.trim() || null;
  if (!sectionType) return null;

  return {
    key: sectionType,
    sdsSectionTypes: SDS_SECTION_TYPES_BY_INTENT[sectionType] ?? [sectionType],
    labelSectionTypes: LABEL_SECTION_TYPES_BY_SDS_SECTION[sectionType] ?? [],
  };
}
