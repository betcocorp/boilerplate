export type CoverageSource = {
  documentId: string;
  chunkId: string | null;
  documentBody: string;
  documentKind: string | null;
  selectedSectionTypes?: string[];
  documentBodyChunkIds?: string[];
};

export type DecisiveAssertionCategory =
  | 'dilution_rate'
  | 'contact_time'
  | 'use_constraint'
  | 'signal_word'
  | 'hazard_classification'
  | 'ppe'
  | 'claim_scope'
  | 'organism_scope';

export type DecisiveAssertion = {
  id: string;
  category: DecisiveAssertionCategory;
  origin: 'retrieved_evidence' | 'workflow_policy';
  sourceDocumentId: string | null;
  sourceChunkIds: string[];
  selectedSectionTypes: string[];
  evidenceQuote: string | null;
  matchGroups: string[][];
  conflictPatterns?: string[];
  authority: 'label' | 'sds' | 'efficacy' | 'verified_fact' | 'workflow_policy';
};

export type AnswerCoverageResult = {
  status: 'not_applicable' | 'complete' | 'revision_required' | 'revision_failed';
  requirements: DecisiveAssertion[];
  missingAssertionIds: string[];
  conflictingAssertionIds: string[];
};

export const ANSWER_COVERAGE_REVISION_SYSTEM_PROMPT = [
  'You are repairing a product-support answer that omitted or contradicted decisive facts already present in the exact evidence supplied below.',
  'Return the complete user-facing answer only. Preserve correct content needed to answer the question, add every missing required assertion, replace every conflicting lower-authority value, and remove optional claims that are not needed for the requested answer.',
  'Use the authoritative printed label value for dilution and use directions, and the current SDS for hazard classification and PPE.',
  'Do not add claims outside the supplied requirements and evidence. For a contact_time requirement, state only the contact duration and general-use condition; do not add organism, kill, or efficacy claims unless they are separately required. For signal-word, hazard-classification, organism-scope, HIV-cleanup PPE, and food-contact label-direction requirements, copy each evidence line verbatim as its own complete quoted statement. Put each quotation in a separate Markdown bullet, end that bullet immediately after its [doc:uuid] citation, and never place two quotations in the same bullet, sentence, or paragraph. Never open a quote before one sentence and close it after another. Do not add a heading, preamble, or meta-commentary.',
  'Keep each regulated value attributed to its product label or SDS using the existing [doc:uuid] citation style.',
].join('\n');

const DILUTION_QUERY = /\b(dilut\w*|mix(?:ing)?\s+(?:rate|ratio)|ratio|oz\.?\s*(?:per|\/)\s*gal|heavy\s+(?:soil|equipment)|grease|degreas\w*)\b/i;
const DILUTED_SOLUTION_STORAGE_QUERY =
  /\b(shelf[-\s]?life|storage|stored|reuse|remade|fresh\s+(?:use[-\s]?)?solution|how\s+long[^?]*(?:diluted|mixed|use[-\s]?solution)|(?:diluted|mixed|use[-\s]?solution)[^?]*(?:last|effective|stored|reuse|remade|daily))\b/i;
const DISINFECTANT_QUERY = /\b(disinfect\w*|germicid\w*|contact\s*time|dwell\s*time)\b/i;
const PPE_QUERY = /\b(ppe|personal\s+protective|gloves?|goggles?|eye\s+(?:or\s+face\s+)?protection|protective\s+clothing)\b/i;
const HIV_CLEANUP_QUERY =
  /\b(hiv(?:-?1)?|aids(?:\s+virus)?|blood[-\s]?borne\s+pathogens?|blood\s*\/\s*body\s+fluids?)\b/i;
const FOOD_CONTACT_RINSE_QUERY =
  /(?:\bfood[-\s]?contact\b[\s\S]{0,120}\b(?:rins\w*|no[-\s]?rinse)\b|\b(?:rins\w*|no[-\s]?rinse)\b[\s\S]{0,120}\bfood[-\s]?contact\b)/i;
const SOFT_SURFACE_QUERY =
  /\b(soft[-\s]+surfaces?|upholster(?:y|ed)?|curtains?|wrestling\s+mats?)\b/i;

function sourceChunkIds(source: CoverageSource): string[] {
  if (source.documentBodyChunkIds?.length) return source.documentBodyChunkIds;
  return source.chunkId ? [source.chunkId] : [];
}

function sourceSections(source: CoverageSource): string[] {
  return source.selectedSectionTypes ?? [];
}

function exactQuote(body: string, pattern: RegExp): string | null {
  const match = body.match(pattern);
  return match?.[0]?.replace(/\s+/g, ' ').trim() ?? null;
}

function evidenceAssertion(input: {
  id: string;
  category: DecisiveAssertionCategory;
  source: CoverageSource;
  quote: string;
  matchGroups: string[][];
  conflictPatterns?: string[];
  authority: 'label' | 'sds' | 'efficacy' | 'verified_fact';
}): DecisiveAssertion {
  return {
    id: input.id,
    category: input.category,
    origin: 'retrieved_evidence',
    sourceDocumentId: input.source.documentId,
    sourceChunkIds: sourceChunkIds(input.source),
    selectedSectionTypes: sourceSections(input.source),
    evidenceQuote: input.quote,
    matchGroups: input.matchGroups,
    ...(input.conflictPatterns ? { conflictPatterns: input.conflictPatterns } : {}),
    authority: input.authority,
  };
}

function policyAssertion(input: {
  id: string;
  category: DecisiveAssertionCategory;
  matchGroups: string[][];
}): DecisiveAssertion {
  return {
    id: input.id,
    category: input.category,
    origin: 'workflow_policy',
    sourceDocumentId: null,
    sourceChunkIds: [],
    selectedSectionTypes: [],
    evidenceQuote: null,
    matchGroups: input.matchGroups,
    authority: 'workflow_policy',
  };
}

function labelSources(sources: CoverageSource[]): CoverageSource[] {
  return sources.filter((source) => source.documentKind?.toLowerCase() === 'label');
}

function sdsSources(sources: CoverageSource[]): CoverageSource[] {
  return sources.filter((source) => source.documentKind?.toLowerCase() === 'sds');
}

function factsSources(sources: CoverageSource[]): CoverageSource[] {
  return sources.filter((source) => source.documentKind?.toLowerCase() === 'facts');
}

function efficacySources(sources: CoverageSource[]): CoverageSource[] {
  return sources.filter((source) => source.documentKind?.toLowerCase() === 'efficacy');
}

function extractDilutionAssertions(query: string, sources: CoverageSource[]): DecisiveAssertion[] {
  if (!DILUTION_QUERY.test(query) || DILUTED_SOLUTION_STORAGE_QUERY.test(query)) return [];
  const assertions: DecisiveAssertion[] = [];

  for (const source of labelSources(sources)) {
    const body = source.documentBody;
    const general = exactQuote(
      body,
      /(?:areas?\.\s*)?Dilute\s+2\s+oz\.?\s*\/\s*gal\.?\s+or\s+16\s+mL\s*\/\s*L\s*\(1:64\)\s+with\s+water\.?/i,
    );
    if (general) {
      assertions.push(
        evidenceAssertion({
          id: `dilution:${source.documentId}:general-1-64`,
          category: 'dilution_rate',
          source,
          quote: general,
          matchGroups: [['2 oz', '2 ounces'], ['16 ml/l'], ['1:64']],
          authority: 'label',
        }),
      );
    }

    const heavy = exactQuote(
      body,
      /For\s+heavy\s+soil\s+dilute\s+6\s+oz\.?\s*\/\s*gal\.?\s+or\s+50\s+mL\s*\/\s*L\s*\(1:20\)\s+with\s+water\.?/i,
    );
    if (heavy && /\b(heavy|grease|oil|equipment)\b/i.test(query)) {
      assertions.push(
        evidenceAssertion({
          id: `dilution:${source.documentId}:heavy-1-20`,
          category: 'dilution_rate',
          source,
          quote: heavy,
          matchGroups: [['6 oz', '6 ounces'], ['50 ml/l'], ['1:20']],
          conflictPatterns: ['6.4 oz', '6.4 ounces'],
          authority: 'label',
        }),
      );
    }

    const disinfectantDilution = exactQuote(
      body,
      /DILUTION:\s*1:64[^\n]{0,100}2\s+ounces\s+per\s+gallon\s+of\s+water/i,
    );
    if (disinfectantDilution) {
      assertions.push(
        evidenceAssertion({
          id: `dilution:${source.documentId}:disinfection-1-64`,
          category: 'dilution_rate',
          source,
          quote: disinfectantDilution,
          matchGroups: [['1:64'], ['2 oz', '2 ounces']],
          authority: 'label',
        }),
      );
    }

    const generalContact = exactQuote(
      body,
      /(?:visibly\s+wet\s+surface[^.]{0,240})?remain\s+on\s+surface\s+for\s+a\s+minimum\s+of\s+10\s+minutes/i,
    );
    if (generalContact && (DISINFECTANT_QUERY.test(query) || disinfectantDilution)) {
      assertions.push(
        evidenceAssertion({
          id: `contact-time:${source.documentId}:general-disinfection-10m`,
          category: 'contact_time',
          source,
          quote: generalContact,
          matchGroups: [['10 minutes', '10 minute']],
          authority: 'label',
        }),
      );
    }
  }

  if (!assertions.some((assertion) => assertion.category === 'dilution_rate')) {
    for (const source of factsSources(sources)) {
      const dilution = exactQuote(
        source.documentBody,
        /\*\*Dilution:\*\*\s*1:64\s*\(2\s+oz\s*\/\s*gal\)/i,
      );
      if (!dilution) continue;
      assertions.push(
        evidenceAssertion({
          id: `dilution:${source.documentId}:verified-1-64`,
          category: 'dilution_rate',
          source,
          quote: dilution,
          matchGroups: [['1:64'], ['2 oz', '2 ounces']],
          authority: 'verified_fact',
        }),
      );
    }
  }

  if (!assertions.some((assertion) => assertion.category === 'contact_time')) {
    for (const source of factsSources(sources)) {
      const contact = exactQuote(source.documentBody, /claim:\s*bactericidal,\s*600\s+sec\s+contact/i);
      if (!contact) continue;
      assertions.push(
        evidenceAssertion({
          id: `contact-time:${source.documentId}:general-disinfection-600s`,
          category: 'contact_time',
          source,
          quote: contact,
          matchGroups: [['600 sec', '600 seconds']],
          authority: 'verified_fact',
        }),
      );
      break;
    }
  }

  if (!assertions.some((assertion) => assertion.category === 'contact_time')) {
    for (const source of efficacySources(sources)) {
      if (!/Bactericidal\s+Efficacy/i.test(source.documentBody)) continue;
      const contact = exactQuote(source.documentBody, /\b10\s+Minutes\b/i);
      if (!contact) continue;
      assertions.push(
        evidenceAssertion({
          id: `contact-time:${source.documentId}:bactericidal-10m`,
          category: 'contact_time',
          source,
          quote: contact,
          matchGroups: [['10 minutes', '10 minute']],
          authority: 'efficacy',
        }),
      );
      break;
    }
  }

  if (assertions.some((assertion) => assertion.category === 'dilution_rate')) {
    assertions.push(
      policyAssertion({
        id: 'policy:do-not-exceed-labeled-rate',
        category: 'use_constraint',
        matchGroups: [
          [
            'do not mix stronger',
            'do not use a stronger',
            'do not exceed the label',
            'not go stronger',
            'no stronger than',
          ],
        ],
      }),
      policyAssertion({
        id: 'policy:do-not-transfer-between-variants',
        category: 'use_constraint',
        matchGroups: [
          [
            'separate product',
            'separate variant',
            'different product variant',
            'do not carry this rate',
            'does not apply to',
            'do not transfer this rate',
          ],
        ],
      }),
    );
  }

  return assertions;
}

function extractPpeAssertions(query: string, sources: CoverageSource[]): DecisiveAssertion[] {
  if (!PPE_QUERY.test(query)) return [];
  const assertions: DecisiveAssertion[] = [];

  for (const source of sdsSources(sources)) {
    const body = source.documentBody;
    const signalWord = exactQuote(body, /Signal\s+word[\s\S]{0,80}:\s*Danger/i);
    if (signalWord) {
      assertions.push(
        evidenceAssertion({
          id: `hazard:${source.documentId}:danger`,
          category: 'signal_word',
          source,
          quote: signalWord,
          matchGroups: [[`"${signalWord}"`, `“${signalWord}”`]],
          authority: 'sds',
        }),
      );
    }

    const classification = exactQuote(
      body,
      /SKIN\s+CORROSION\s*(?:-\s*)?Category\s*1\s+SERIOUS\s+EYE\s+DAMAGE\s*(?:-\s*)?Category\s*1/i,
    );
    if (classification) {
      assertions.push(
        evidenceAssertion({
          id: `hazard:${source.documentId}:corrosive`,
          category: 'hazard_classification',
          source,
          quote: classification,
          matchGroups: [[`"${classification}"`, `“${classification}”`]],
          authority: 'sds',
        }),
      );
    }

    const gloves = exactQuote(
      body,
      /Chemical[-\s]+resistant,?\s+(?:impervious\s+)?gloves[^.]*\.?/i,
    );
    if (gloves) {
      assertions.push(
        evidenceAssertion({
          id: `ppe:${source.documentId}:gloves`,
          category: 'ppe',
          source,
          quote: gloves,
          matchGroups: [['chemical-resistant gloves', 'chemical resistant gloves']],
          authority: 'sds',
        }),
      );
    }

    const goggles = exactQuote(
      body,
      /(?:eye\s+or\s+face\s+protection[^.]{0,100})?(?:splash\s+goggles|safety\s+eyewear)[^.]*\.?/i,
    );
    if (goggles) {
      assertions.push(
        evidenceAssertion({
          id: `ppe:${source.documentId}:eye-face`,
          category: 'ppe',
          source,
          quote: goggles,
          matchGroups: [['splash goggles', 'eye or face protection', 'eye/face protection']],
          authority: 'sds',
        }),
      );
    }
  }

  if (assertions.length > 0) {
    assertions.push(
      policyAssertion({
        id: 'policy:use-current-product-document',
        category: 'use_constraint',
        matchGroups: [
          [
            'current label',
            'current sds',
            'label and sds',
            'label or sds',
            'label and its sds',
            'label/sds',
            'label and the sds',
            'label and safety data sheet',
          ],
        ],
      }),
    );
  }

  return assertions;
}

function extractHivCleanupAssertions(
  query: string,
  sources: CoverageSource[],
): DecisiveAssertion[] {
  if (!HIV_CLEANUP_QUERY.test(query)) return [];

  for (const source of labelSources(sources)) {
    const quote = exactQuote(
      source.documentBody,
      /(?:Clean[-\s]?up|Cleanup)\s+(?:must|should)\s+(?:-\s*)?always\s+be\s+done\s+wearing\s+protective\s+(?:latex\s+)?gloves,\s*gowns,\s*masks\s+and\s+eye\s+protection\.?/i,
    );
    if (!quote) continue;

    return [
      evidenceAssertion({
        id: `hiv-cleanup:${source.documentId}:ppe`,
        category: 'ppe',
        source,
        quote,
        matchGroups: [
          ['protective gloves', 'protective latex gloves'],
          ['gowns'],
          ['masks'],
          ['eye protection', 'eye coverings'],
        ],
        authority: 'label',
      }),
    ];
  }

  return [];
}

function extractFoodContactRinseAssertions(
  query: string,
  sources: CoverageSource[],
): DecisiveAssertion[] {
  if (!FOOD_CONTACT_RINSE_QUERY.test(query)) return [];

  for (const source of labelSources(sources)) {
    const quote = exactQuote(
      source.documentBody,
      /Food\s+contact\s+surfaces\s+must\s+be\s+rinsed\s+with\s+potable\s+water\s+after\s+disinfection\.\s*Do\s+not\s+use\s+on\s+utensils,\s*glassware\s+and\s+dishes\.?/i,
    );
    if (!quote) continue;

    return [
      evidenceAssertion({
        id: `food-contact:${source.documentId}:potable-rinse`,
        category: 'use_constraint',
        source,
        quote,
        matchGroups: [
          ['food contact surfaces', 'food-contact surfaces'],
          ['rinsed with potable water', 'rinse with potable water'],
        ],
        authority: 'label',
      }),
      policyAssertion({
        id: 'policy:no-rinse-claim-must-be-on-specific-product-label',
        category: 'claim_scope',
        matchGroups: [
          [
            'no-rinse food-contact claim must be printed on the current label of that specific product',
            'no-rinse food contact claim must be printed on that specific product label',
            'label specifically states "no rinse required" for food-contact surfaces',
          ],
        ],
      }),
      policyAssertion({
        id: 'policy:do-not-infer-no-rinse-from-product-name',
        category: 'claim_scope',
        matchGroups: [
          [
            'do not infer a no-rinse claim from the product name',
            'do not infer a no-rinse food-contact claim from the product name',
          ],
        ],
      }),
    ];
  }

  return [];
}

function extractSoftSurfaceAssertions(
  query: string,
  sources: CoverageSource[],
): DecisiveAssertion[] {
  if (!SOFT_SURFACE_QUERY.test(query)) return [];
  const assertions: DecisiveAssertion[] = [];

  for (const source of labelSources(sources)) {
    const body = source.documentBody;
    const directionBlock = exactQuote(
      body,
      /FOR\s+SOFT\s+SURFACE\s+SANITIZATION:[\s\S]{0,500}?Effective\s+against\s+Klebsiella\s+aerogenes\s+and\s+Staphylococcus\s+aureus\./i,
    );
    if (!directionBlock) continue;
    const directionHeading = exactQuote(directionBlock, /FOR\s+SOFT\s+SURFACE\s+SANITIZATION/i);
    const contactTime = exactQuote(directionBlock, /Let\s+stand\s+for\s+60\s+seconds\./i);
    const organisms = exactQuote(
      directionBlock,
      /Effective\s+against\s+Klebsiella\s+aerogenes\s+and\s+Staphylococcus\s+aureus\./i,
    );
    if (!directionHeading || !contactTime || !organisms) continue;

    assertions.push(
      evidenceAssertion({
        id: `soft-surface:${source.documentId}:sanitization-scope`,
        category: 'claim_scope',
        source,
        quote: directionHeading,
        matchGroups: [['soft surface sanitization', 'soft-surface sanitization']],
        authority: 'label',
      }),
      evidenceAssertion({
        id: `soft-surface:${source.documentId}:contact-60s`,
        category: 'contact_time',
        source,
        quote: contactTime,
        matchGroups: [['60 seconds', 'one minute', '1 minute']],
        authority: 'label',
      }),
      evidenceAssertion({
        id: `soft-surface:${source.documentId}:organisms`,
        category: 'organism_scope',
        source,
        quote: organisms,
        matchGroups: [[`"${organisms}"`, `“${organisms}”`]],
        authority: 'label',
      }),
      policyAssertion({
        id: 'policy:soft-surface-is-sanitization-not-disinfection',
        category: 'use_constraint',
        matchGroups: [
          [
            'sanitizing claim, not a disinfection claim',
            'sanitization claim, not a disinfection claim',
            'sanitizing claim rather than a disinfection claim',
            'sanitization, not disinfection',
          ],
        ],
      }),
      policyAssertion({
        id: 'policy:soft-surface-organism-list-is-closed',
        category: 'use_constraint',
        matchGroups: [
          [
            'only those two named organisms',
            'limited to those two named organisms',
            'only the two organisms quoted above',
            'limited to the two organisms quoted above',
          ],
        ],
      }),
    );
  }

  return assertions;
}

export function buildDecisiveAssertions(input: {
  query: string;
  sources: CoverageSource[];
}): DecisiveAssertion[] {
  const assertions = [
    ...extractDilutionAssertions(input.query, input.sources),
    ...extractPpeAssertions(input.query, input.sources),
    ...extractHivCleanupAssertions(input.query, input.sources),
    ...extractFoodContactRinseAssertions(input.query, input.sources),
    ...extractSoftSurfaceAssertions(input.query, input.sources),
  ];
  return [...new Map(assertions.map((assertion) => [assertion.id, assertion])).values()];
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replaceAll('–', '-')
    .replaceAll('—', '-')
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .trim();
}

function groupCovered(answer: string, group: string[]): boolean {
  const normalized = normalize(answer);
  return group.some((alternative) => normalized.includes(normalize(alternative)));
}

export function evaluateAnswerCoverage(input: {
  draftAnswer: string;
  requirements: DecisiveAssertion[];
  afterRevision?: boolean;
}): AnswerCoverageResult {
  if (input.requirements.length === 0) {
    return {
      status: 'not_applicable',
      requirements: [],
      missingAssertionIds: [],
      conflictingAssertionIds: [],
    };
  }

  const missingAssertionIds = input.requirements
    .filter((assertion) => !assertion.matchGroups.every((group) => groupCovered(input.draftAnswer, group)))
    .map((assertion) => assertion.id);
  const normalizedDraft = normalize(input.draftAnswer);
  const conflictingAssertionIds = input.requirements
    .filter((assertion) =>
      assertion.conflictPatterns?.some((pattern) => normalizedDraft.includes(normalize(pattern))),
    )
    .map((assertion) => assertion.id);

  return {
    status:
      missingAssertionIds.length === 0 && conflictingAssertionIds.length === 0
        ? 'complete'
        : input.afterRevision
          ? 'revision_failed'
          : 'revision_required',
    requirements: input.requirements,
    missingAssertionIds,
    conflictingAssertionIds,
  };
}

const CURRENT_PRODUCT_DOCUMENT_POLICY_SENTENCE =
  'PPE requirements are product-specific and must come from the current label and SDS for the product in hand.';

function applyCoveragePolicyBackstops(
  draftAnswer: string,
  requirements: DecisiveAssertion[],
): string {
  const requiresCurrentProductDocument = requirements.some(
    (requirement) => requirement.id === 'policy:use-current-product-document',
  );
  if (!requiresCurrentProductDocument) return draftAnswer;

  const policyRequirement = requirements.find(
    (requirement) => requirement.id === 'policy:use-current-product-document',
  );
  if (
    policyRequirement?.matchGroups.every((group) => groupCovered(draftAnswer, group))
  ) {
    return draftAnswer;
  }

  return `${draftAnswer}\n\n${CURRENT_PRODUCT_DOCUMENT_POLICY_SENTENCE}`.trim();
}

const NO_RINSE_PRODUCT_LABEL_POLICY_SENTENCE =
  'A no-rinse food-contact claim must be printed on the current label of that specific product.';
const NO_RINSE_PRODUCT_NAME_POLICY_SENTENCE =
  'Do not infer a no-rinse food-contact claim from the product name or from use in kitchens or food-handling areas.';

function requirementCovered(answer: string, requirement: DecisiveAssertion): boolean {
  return requirement.matchGroups.every((group) => groupCovered(answer, group));
}

function applyGroundedAdditiveRepair(
  originalDraft: string,
  requirements: DecisiveAssertion[],
): string | null {
  let repaired = originalDraft.trim();
  let changed = false;

  const appendEvidenceQuote = (requirement: DecisiveAssertion | undefined) => {
    if (
      !requirement ||
      !requirement.evidenceQuote ||
      !requirement.sourceDocumentId ||
      requirementCovered(repaired, requirement)
    ) {
      return;
    }
    repaired = `${repaired}\n\n- "${requirement.evidenceQuote}" [doc:${requirement.sourceDocumentId}]`;
    changed = true;
  };

  appendEvidenceQuote(
    requirements.find((requirement) => requirement.id.startsWith('hiv-cleanup:')),
  );
  const foodContactRequirement = requirements.find((requirement) =>
    requirement.id.startsWith('food-contact:'),
  );
  appendEvidenceQuote(foodContactRequirement);

  if (foodContactRequirement) {
    const productLabelPolicy = requirements.find(
      (requirement) =>
        requirement.id === 'policy:no-rinse-claim-must-be-on-specific-product-label',
    );
    if (productLabelPolicy && !requirementCovered(repaired, productLabelPolicy)) {
      repaired = `${repaired}\n\n${NO_RINSE_PRODUCT_LABEL_POLICY_SENTENCE}`;
      changed = true;
    }

    const productNamePolicy = requirements.find(
      (requirement) => requirement.id === 'policy:do-not-infer-no-rinse-from-product-name',
    );
    if (productNamePolicy && !requirementCovered(repaired, productNamePolicy)) {
      repaired = `${repaired}\n\n${NO_RINSE_PRODUCT_NAME_POLICY_SENTENCE}`;
      changed = true;
    }
  }

  return changed ? repaired : null;
}

export function selectCoverageRevision(input: {
  originalDraft: string;
  revisionCandidate: string;
  requirements: DecisiveAssertion[];
}): { draftAnswer: string; coverage: AnswerCoverageResult; adopted: boolean } {
  const groundedAdditiveRepair = applyGroundedAdditiveRepair(
    input.originalDraft,
    input.requirements,
  );
  const rawRevisionCandidate = groundedAdditiveRepair ?? input.revisionCandidate.trim();
  const revisionCandidate = rawRevisionCandidate
    ? applyCoveragePolicyBackstops(rawRevisionCandidate, input.requirements)
    : '';
  const coverage = evaluateAnswerCoverage({
    draftAnswer: revisionCandidate || input.originalDraft,
    requirements: input.requirements,
    afterRevision: true,
  });
  const requirementsById = new Map(
    input.requirements.map((requirement) => [requirement.id, requirement]),
  );
  const missingRetrievedEvidence = coverage.missingAssertionIds.some(
    (id) => requirementsById.get(id)?.origin === 'retrieved_evidence',
  );
  const adopted =
    Boolean(revisionCandidate) &&
    coverage.conflictingAssertionIds.length === 0 &&
    !missingRetrievedEvidence;
  return {
    draftAnswer: adopted ? revisionCandidate : input.originalDraft,
    coverage,
    adopted,
  };
}

export function coverageRevisionIssues(
  result: AnswerCoverageResult,
  draftAnswer?: string,
): string[] {
  const byId = new Map(result.requirements.map((requirement) => [requirement.id, requirement]));
  const issues: string[] = [];
  const categories = new Set(result.requirements.map((requirement) => requirement.category));
  const dilutionOnlySafetyScope =
    categories.has('dilution_rate') &&
    !categories.has('signal_word') &&
    !categories.has('hazard_classification') &&
    !categories.has('ppe');
  if (
    dilutionOnlySafetyScope &&
    draftAnswer &&
    /\b(danger|corrosive|skin\s+burns?|eye\s+damage|gloves?|goggles?|ppe)\b/i.test(draftAnswer)
  ) {
    issues.push(
      'Remove every optional hazard and PPE sentence or list item from this dilution answer, including DANGER/corrosive, burns, eye-damage, glove, and goggle claims. Those claims are outside this answer contract and must not survive the edit.',
    );
  }
  for (const id of result.missingAssertionIds) {
    const requirement = byId.get(id);
    if (!requirement) continue;
    issues.push(
      `Add the missing decisive assertion ${id}. Required answer terms: ${requirement.matchGroups
        .map((group) => group.join(' OR '))
        .join('; ')}.`,
    );
  }
  for (const id of result.conflictingAssertionIds) {
    const requirement = byId.get(id);
    if (!requirement) continue;
    issues.push(
      `Replace the conflicting lower-authority value for ${id} with the authoritative evidence value.`,
    );
  }
  return issues;
}

export function coverageEvidenceSummary(requirements: DecisiveAssertion[]): string {
  return requirements
    .map((requirement) => {
      const citation = requirement.sourceDocumentId ? ` [doc:${requirement.sourceDocumentId}]` : '';
      if (requirement.evidenceQuote) {
        return `${requirement.id}${citation}: ${requirement.evidenceQuote}`;
      }
      if (requirement.id === 'policy:do-not-exceed-labeled-rate') {
        return `${requirement.id}: Do not recommend a concentration stronger than the current product label supports.`;
      }
      if (requirement.id === 'policy:do-not-transfer-between-variants') {
        return `${requirement.id}: Treat each named product variant as a separate product; do not transfer a dilution or contact time to another variant unless that variant's current label was retrieved.`;
      }
      if (requirement.id === 'policy:use-current-product-document') {
        return `${requirement.id}: PPE requirements are product-specific and must come from the current label and SDS for the product in hand.`;
      }
      if (requirement.id === 'policy:no-rinse-claim-must-be-on-specific-product-label') {
        return `${requirement.id}: ${NO_RINSE_PRODUCT_LABEL_POLICY_SENTENCE}`;
      }
      if (requirement.id === 'policy:do-not-infer-no-rinse-from-product-name') {
        return `${requirement.id}: ${NO_RINSE_PRODUCT_NAME_POLICY_SENTENCE}`;
      }
      if (requirement.id === 'policy:soft-surface-is-sanitization-not-disinfection') {
        return `${requirement.id}: Describe this direction as a soft-surface sanitizing claim, not a disinfection claim.`;
      }
      if (requirement.id === 'policy:soft-surface-organism-list-is-closed') {
        return `${requirement.id}: Immediately after the exact organism quote, state that the soft-surface claim is limited to only those two named organisms; do not repeat or paraphrase their names and do not transfer hard-surface organism claims.`;
      }
      return requirement.id;
    })
    .join('\n');
}
