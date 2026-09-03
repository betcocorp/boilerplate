import { describe, expect, it } from 'vitest';

import type { ToolTraceEntry } from '~/lib/audit/trace';
import {
  buildAliasFuzzyDisclosureSentence,
  draftAlreadyDisclosesAliasCorrection,
  extractAliasFuzzyDisclosureFromToolOutputs,
  maybeDiscloseAliasFuzzyMatch,
} from '~/lib/workflows/product-support/run-product-support-workflow';
import { evaluateRegulatedClaimGrounding } from '~/lib/workflows/product-support/validator';

/**
 * B0-700 follow-up — `gpt-4.1-mini` was confirmed (live, twice) to ignore the prompt-only
 * disclosure rule when a product name resolves via a fuzzy/typo-tolerant alias match (e.g. user
 * asks about "AG79 Concentrate Disinfectant", the resolver correctly finds "AF79 Concentrate
 * Disinfectant"). This suite exercises the deterministic, code-level backstop that guarantees the
 * disclosure sentence regardless of model compliance.
 */

function trace(overrides: Partial<ToolTraceEntry> = {}): ToolTraceEntry {
  return {
    toolName: 'get_efficacy_data',
    callId: 'call_1',
    argumentsPreview: '{}',
    outputPreview: '{}',
    ok: true,
    ...overrides,
  };
}

/** Real shape confirmed via Supabase for a `get_efficacy_data` call on "AG79 Concentrate
 * Disinfectant" that alias-resolved (fuzzy) to "AF 79Concentrate" (the real `rag.entity.title`). */
function efficacyToolOutput(input: {
  askedFor: string;
  outcome: 'alias_exact' | 'alias_fuzzy' | 'no_alias_match' | 'ambiguous_alias';
  matchedTitle: string | null;
  ok?: boolean;
  traceOverrides?: Partial<ToolTraceEntry>;
}) {
  const entryTrace = trace(input.traceOverrides);
  return {
    toolName: 'get_efficacy_data',
    ok: input.ok ?? true,
    output: JSON.stringify({
      ok: true,
      adapter: 'structured_facts_v1',
      aliasResolution: {
        attempted: true,
        outcome: input.outcome,
        mode: 'name',
        matchedTitle: input.matchedTitle,
      },
      productId: input.askedFor,
      organism: null,
      facts: { entityId: '5348c339-7523-4978-adf8-b14ba06955ec', dilutionOzPerGal: 32 },
    }),
    trace: entryTrace,
  };
}

const AG79_ASKED_FOR = 'AG79 Concentrate Disinfectant';
const AF79_RESOLVED_TITLE = 'AF 79Concentrate';

describe('extractAliasFuzzyDisclosureFromToolOutputs (B0-700 follow-up)', () => {
  it('finds the AG79 -> AF79 fuzzy-alias hit', () => {
    const match = extractAliasFuzzyDisclosureFromToolOutputs([
      efficacyToolOutput({
        askedFor: AG79_ASKED_FOR,
        outcome: 'alias_fuzzy',
        matchedTitle: AF79_RESOLVED_TITLE,
      }),
    ]);
    expect(match).toEqual({ askedForName: AG79_ASKED_FOR, resolvedTitle: AF79_RESOLVED_TITLE });
  });

  it('does NOT fire on alias_exact — no disclosure needed', () => {
    const match = extractAliasFuzzyDisclosureFromToolOutputs([
      efficacyToolOutput({
        askedFor: 'AF79 Concentrate Disinfectant',
        outcome: 'alias_exact',
        matchedTitle: 'AF 79Concentrate',
      }),
    ]);
    expect(match).toBeNull();
  });

  it('does NOT fire on no_alias_match or ambiguous_alias — the existing decline path owns those', () => {
    for (const outcome of ['no_alias_match', 'ambiguous_alias'] as const) {
      const match = extractAliasFuzzyDisclosureFromToolOutputs([
        efficacyToolOutput({ askedFor: 'Some Unknown Product', outcome, matchedTitle: null }),
      ]);
      expect(match).toBeNull();
    }
  });

  it('does NOT fire when the call failed (ok: false)', () => {
    const match = extractAliasFuzzyDisclosureFromToolOutputs([
      efficacyToolOutput({
        askedFor: AG79_ASKED_FOR,
        outcome: 'alias_fuzzy',
        matchedTitle: AF79_RESOLVED_TITLE,
        ok: false,
      }),
    ]);
    expect(match).toBeNull();
  });

  it('does NOT fire for an unendorsed speculative call whose product-line resolution never locked (B0-635)', () => {
    const match = extractAliasFuzzyDisclosureFromToolOutputs([
      efficacyToolOutput({
        askedFor: AG79_ASKED_FOR,
        outcome: 'alias_fuzzy',
        matchedTitle: AF79_RESOLVED_TITLE,
        traceOverrides: {
          speculative: true,
          retrieval: {
            model: 'text-embedding-3-large',
            limit: 40,
            scope: 'betco_us',
            productLineKey: null,
            productKey: null,
            sectionType: null,
            minSimilarity: null,
            retrievalStrategy: 'hybrid_rrf',
            embeddingSource: 'fresh',
            timings: {
              totalMs: 100,
              queryEmbeddingMs: 10,
              queryRewriteMs: 0,
              cacheLookupMs: 1,
              embeddingCreateMs: 9,
              cachePersistMs: 1,
              similaritySearchMs: 50,
              rerankMs: 30,
            },
            productLineResolution: {
              candidates: [],
              lockedProductLineKey: null,
              lockReason: 'skipped_low_confidence',
            },
          },
        },
      }),
    ]);
    expect(match).toBeNull();
  });

  it('skips a call with no matchedTitle rather than inventing a name', () => {
    const match = extractAliasFuzzyDisclosureFromToolOutputs([
      efficacyToolOutput({ askedFor: AG79_ASKED_FOR, outcome: 'alias_fuzzy', matchedTitle: null }),
    ]);
    expect(match).toBeNull();
  });

  it('scans the LAST relevant call when several tool calls ran this turn', () => {
    const match = extractAliasFuzzyDisclosureFromToolOutputs([
      efficacyToolOutput({
        askedFor: 'Some Other Product',
        outcome: 'alias_fuzzy',
        matchedTitle: 'Unrelated Resolved Product',
        traceOverrides: { callId: 'call_earlier' },
      }),
      efficacyToolOutput({
        askedFor: AG79_ASKED_FOR,
        outcome: 'alias_fuzzy',
        matchedTitle: AF79_RESOLVED_TITLE,
        traceOverrides: { callId: 'call_later' },
      }),
    ]);
    expect(match).toEqual({ askedForName: AG79_ASKED_FOR, resolvedTitle: AF79_RESOLVED_TITLE });
  });
});

describe('draftAlreadyDisclosesAliasCorrection', () => {
  it('recognizes the prompt-rule phrasing the model is supposed to use', () => {
    expect(
      draftAlreadyDisclosesAliasCorrection(
        "I couldn't find an exact match for 'AG79', but found AF79 Concentrate Disinfectant — here is its information:",
      ),
    ).toBe(true);
  });

  it('does NOT flag an ordinary answer with no disclosure language', () => {
    expect(
      draftAlreadyDisclosesAliasCorrection(
        'AF79 Concentrate Disinfectant should be diluted at 32 oz/gal for general use.',
      ),
    ).toBe(false);
  });
});

describe('buildAliasFuzzyDisclosureSentence', () => {
  it('transcribes both names verbatim, never reformatted', () => {
    const sentence = buildAliasFuzzyDisclosureSentence({
      askedForName: AG79_ASKED_FOR,
      resolvedTitle: AF79_RESOLVED_TITLE,
    });
    expect(sentence).toContain(AG79_ASKED_FOR);
    expect(sentence).toContain(AF79_RESOLVED_TITLE);
  });
});

describe('maybeDiscloseAliasFuzzyMatch (B0-700 follow-up, AG79 -> AF79 repro)', () => {
  const AF79_DRAFT_ANSWER =
    'AF79 Concentrate Disinfectant is diluted at 4 oz/gal (1:32) for general disinfection, with a 10 minute contact time.';

  it('prepends the disclosure when the model answered without disclosing the correction', () => {
    const result = maybeDiscloseAliasFuzzyMatch(AF79_DRAFT_ANSWER, [
      efficacyToolOutput({
        askedFor: AG79_ASKED_FOR,
        outcome: 'alias_fuzzy',
        matchedTitle: AF79_RESOLVED_TITLE,
      }),
    ]);
    expect(result).toContain(AG79_ASKED_FOR);
    expect(result).toContain(AF79_RESOLVED_TITLE);
    expect(result.endsWith(AF79_DRAFT_ANSWER)).toBe(true);
  });

  it('is idempotent — leaves the draft untouched when the model already disclosed the correction', () => {
    const alreadyDisclosed = `I couldn't find an exact match for "${AG79_ASKED_FOR}", but found ${AF79_RESOLVED_TITLE} — here is its information:\n\n${AF79_DRAFT_ANSWER}`;
    const result = maybeDiscloseAliasFuzzyMatch(alreadyDisclosed, [
      efficacyToolOutput({
        askedFor: AG79_ASKED_FOR,
        outcome: 'alias_fuzzy',
        matchedTitle: AF79_RESOLVED_TITLE,
      }),
    ]);
    expect(result).toBe(alreadyDisclosed);
  });

  it('is a no-op when the resolution was alias_exact', () => {
    const result = maybeDiscloseAliasFuzzyMatch(AF79_DRAFT_ANSWER, [
      efficacyToolOutput({
        askedFor: 'AF79 Concentrate Disinfectant',
        outcome: 'alias_exact',
        matchedTitle: AF79_RESOLVED_TITLE,
      }),
    ]);
    expect(result).toBe(AF79_DRAFT_ANSWER);
  });

  it('is a no-op when the draft is already a decline — nothing to disclose a correction for', () => {
    const decline =
      "I don't have enough verified information to answer that. Please contact a Betco sales representative.";
    const result = maybeDiscloseAliasFuzzyMatch(decline, [
      efficacyToolOutput({
        askedFor: AG79_ASKED_FOR,
        outcome: 'alias_fuzzy',
        matchedTitle: AF79_RESOLVED_TITLE,
      }),
    ]);
    expect(result).toBe(decline);
  });

  it('is a no-op when no tool call in the trace resolved via alias_fuzzy', () => {
    const result = maybeDiscloseAliasFuzzyMatch(AF79_DRAFT_ANSWER, []);
    expect(result).toBe(AF79_DRAFT_ANSWER);
  });
});

describe('the prepended disclosure sentence does not trip the regulated-claim guardrail', () => {
  /** Same label body the guardrail would have retrieved for AF79 — the disclosure sentence itself
   * carries no dilution/EPA/DIN/CAS/contact-time/hazard/compatibility/efficacy-shaped claim, so
   * prepending it must not change the guardrail's verdict on the underlying grounded answer. */
  const AF79_LABEL_SOURCE = {
    documentId: 'doc-af79-label',
    title: 'AF 79Concentrate',
    documentBody: [
      'Product: AF 79Concentrate',
      'EPA Reg. No. 1677-129',
      'Directions for Use:',
      'Dilute at 4 oz. per gallon of water for general disinfection.',
      'Kill Claims:',
      'Effective against Staphylococcus aureus with a 10 minute contact time.',
    ].join('\n'),
  };

  const groundedDraft =
    'AF79 Concentrate Disinfectant (EPA Reg. No. 1677-129) is diluted at 4 oz. per gallon of water for general disinfection, with a 10 minute contact time against Staphylococcus aureus.';

  it('verdict is identical before and after the disclosure prepend', () => {
    const before = evaluateRegulatedClaimGrounding({
      draftAnswer: groundedDraft,
      sources: [AF79_LABEL_SOURCE],
    });

    const disclosed = maybeDiscloseAliasFuzzyMatch(groundedDraft, [
      efficacyToolOutput({
        askedFor: AG79_ASKED_FOR,
        outcome: 'alias_fuzzy',
        matchedTitle: AF79_RESOLVED_TITLE,
      }),
    ]);
    expect(disclosed).not.toBe(groundedDraft);

    const after = evaluateRegulatedClaimGrounding({
      draftAnswer: disclosed,
      sources: [AF79_LABEL_SOURCE],
    });

    expect(after.categoriesDetected).toEqual(before.categoriesDetected);
    expect(after.ungroundedCategories).toEqual(before.ungroundedCategories);
    expect(after.ungroundedCategories).toEqual([]);
  });
});
