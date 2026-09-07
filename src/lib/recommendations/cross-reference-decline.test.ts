import { describe, expect, it } from 'vitest';

import { CROSS_REFERENCE_CLAIMS_NON_TRANSFER_STATEMENT } from '~/lib/agents/cross-reference-specialist/cross-reference-specialist-system-prompt';
import { XREF_DECLINE_COPY } from '~/lib/recommendations/confidence-scoring';
import {
  asksForIdenticalProduct,
  buildBetcoSelfReferenceDecline,
  buildCompetitorIdentityClarification,
  buildGenericChemistryClarification,
  buildRecommendationEngineDeclineCopy,
  isClaimEquivalenceQuestion,
} from '~/lib/recommendations/cross-reference-decline';
import { evaluateRegulatedClaimGrounding } from '~/lib/workflows/product-support/validator';

/** The three golden rows B0-875 was filed against. */
const GENERIC_CHEMISTRY_QUESTION =
  'I need a Betco replacement for a Diversey quat disinfectant. Which one?';
const CLAIM_EQUIVALENCE_QUESTION = "Betco's version of BNC-15 kills everything BNC-15 does, right?";
const IDENTICAL_QUESTION =
  'Which Betco product is identical to the competitor product we\'re using now?';

/** Every copy this module emits must pass the regulated-claim guardrail with NO sources at all. */
function expectGuardrailClean(text: string) {
  const grounding = evaluateRegulatedClaimGrounding({ draftAnswer: text, sources: [] });
  expect(grounding.ungroundedCategories, text).toEqual([]);
}

describe('isClaimEquivalenceQuestion (B0-875)', () => {
  it('recognises the golden "kills everything X does" shape and its siblings', () => {
    expect(isClaimEquivalenceQuestion(CLAIM_EQUIVALENCE_QUESTION)).toBe(true);
    expect(isClaimEquivalenceQuestion('Does Triforce have the same kill claims as BNC-15?')).toBe(true);
    expect(isClaimEquivalenceQuestion('Do the organism claims transfer to the Betco equivalent?')).toBe(
      true,
    );
    expect(isClaimEquivalenceQuestion('Same log reduction as Virex II 256?')).toBe(true);
  });

  it('does NOT fire on a plain equivalence ask', () => {
    expect(isClaimEquivalenceQuestion('What is the Betco equivalent to BNC-15?')).toBe(false);
    expect(isClaimEquivalenceQuestion(GENERIC_CHEMISTRY_QUESTION)).toBe(false);
    expect(isClaimEquivalenceQuestion(IDENTICAL_QUESTION)).toBe(false);
  });
});

describe('buildCompetitorIdentityClarification (P#10)', () => {
  it('asks for brand + product name and explains comparable-for-the-same-application', () => {
    const copy = buildCompetitorIdentityClarification({
      userMessage: "What's the Betco equivalent to what we're currently using?",
    });
    expect(copy).toContain('brand and the exact product name');
    expect(copy).toContain('EPA registration number');
    expect(copy).toContain('comparable products for the same application');
    expect(copy).not.toMatch(/identical/i);
    expect(copy).not.toContain('Comparable Betco product');
    expectGuardrailClean(copy);
  });

  it('adds the "not chemically identical" clause only when the user asked for "identical"', () => {
    expect(asksForIdenticalProduct(IDENTICAL_QUESTION)).toBe(true);
    const copy = buildCompetitorIdentityClarification({ userMessage: IDENTICAL_QUESTION });
    expect(copy).toContain('not chemically identical ones');
    // Never an affirmative "identical" — the only occurrence is the negation.
    expect(copy.match(/identical/gi)).toHaveLength(1);
    expectGuardrailClean(copy);
  });
});

describe('buildGenericChemistryClarification (P#8)', () => {
  it('quotes the description back, names no Betco product, asks for label name + EPA reg. no.', () => {
    const copy = buildGenericChemistryClarification({ described: 'diversey quat disinfectant' });
    expect(copy).toContain('"diversey quat disinfectant" describes a chemistry class');
    expect(copy).toContain('dilution, contact time and organism claims');
    expect(copy).toContain('product name as printed on its label');
    expect(copy).toContain('EPA registration number');
    expect(copy).not.toMatch(/AF79|Crew|Comparable Betco product/);
    expectGuardrailClean(copy);
  });

  it('still reads when the description is blank', () => {
    expect(buildGenericChemistryClarification({ described: '  ' })).toMatch(
      /^That describes a chemistry class/,
    );
  });
});

describe('buildRecommendationEngineDeclineCopy (P#9)', () => {
  it('leads with the shared non-transfer statement for a claim-equivalence question, engine text verbatim after it', () => {
    const copy = buildRecommendationEngineDeclineCopy({
      userMessage: CLAIM_EQUIVALENCE_QUESTION,
      engineDeclineText: XREF_DECLINE_COPY,
    });
    expect(copy.startsWith('Kill claims do not transfer between products.')).toBe(true);
    expect(copy).toContain(CROSS_REFERENCE_CLAIMS_NON_TRANSFER_STATEMENT);
    expect(copy).toContain('Betco label');
    expect(copy.endsWith(XREF_DECLINE_COPY)).toBe(true);
    expect(copy.indexOf(CROSS_REFERENCE_CLAIMS_NON_TRANSFER_STATEMENT)).toBeLessThan(
      copy.indexOf(XREF_DECLINE_COPY),
    );
    expectGuardrailClean(copy);
  });

  it('returns the engine decline text unchanged for any other question (P#… resolved-but-weak)', () => {
    expect(
      buildRecommendationEngineDeclineCopy({
        userMessage: 'What is the Betco equivalent to BNC-15?',
        engineDeclineText: XREF_DECLINE_COPY,
      }),
    ).toBe(XREF_DECLINE_COPY);
  });
});

describe('buildBetcoSelfReferenceDecline (B0-876)', () => {
  it('names the product as Betco\'s own, cites the betco.com page title, and offers the Betco-product path', () => {
    const copy = buildBetcoSelfReferenceDecline({
      label: 'GE Fight Bac RTU',
      pageTitle: 'GE Fight Bac™ RTU Disinfectant (Canada)',
    });
    expect(copy).toContain('GE Fight Bac RTU appears to be a Betco product');
    expect(copy).toContain('betco.com product page ("GE Fight Bac™ RTU Disinfectant (Canada)")');
    expect(copy).not.toContain('Comparable Betco product');
    expectGuardrailClean(copy);
  });
});

/** The shared statement itself must never read as an ungrounded efficacy claim. */
it('CROSS_REFERENCE_CLAIMS_NON_TRANSFER_STATEMENT passes the regulated-claim guardrail on its own', () => {
  expectGuardrailClean(CROSS_REFERENCE_CLAIMS_NON_TRANSFER_STATEMENT);
});
