import { describe, expect, it } from 'vitest';

import type { ToolTraceEntry } from '~/lib/audit/trace';
import {
  ALIAS_FUZZY_CORRECTION_INVITE,
  buildAliasFuzzyDisclosureSentence,
  draftAlreadyDisclosesAliasCorrection,
  extractAliasFuzzyDisclosureFromToolOutputs,
  maybeDiscloseAliasFuzzyMatch,
  rewriteAskedForNameToResolved,
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

  /**
   * B0-875 (P#8) — the enforced `search_product_docs` after a cross-reference hit is seeded with the
   * LEGACY match's Betco title, not anything the user typed; when that match was a fuzzy row
   * (`fallbackRecommended: true`) its title alias-resolved fuzzily and the disclosure quoted a
   * cross-reference candidate back at the user as if they had asked for it.
   */
  it('does NOT fire for a workflow_injected call — the disclosure only echoes a name the user asked for', () => {
    const match = extractAliasFuzzyDisclosureFromToolOutputs([
      {
        toolName: 'search_product_docs',
        ok: true,
        output: JSON.stringify({
          ok: true,
          query: 'AF79 Concentrate Disinfectant',
          aliasResolution: {
            attempted: true,
            outcome: 'alias_fuzzy',
            mode: 'name',
            matchedTitle: AF79_RESOLVED_TITLE,
          },
          sources: [],
        }),
        trace: trace({
          toolName: 'search_product_docs',
          callId: 'forced-search-1',
          origin: 'workflow_injected',
        }),
      },
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
    // B0-830: disclosure sentence + (rewritten) body + the correction invite, in that order.
    expect(result).toContain(AF79_DRAFT_ANSWER);
    expect(result.endsWith(ALIAS_FUZZY_CORRECTION_INVITE)).toBe(true);
    expect(result.indexOf(AF79_DRAFT_ANSWER)).toBeGreaterThan(result.indexOf(AG79_ASKED_FOR));
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

describe('rewriteAskedForNameToResolved (B0-830 — the misspelled name must not survive in the body)', () => {
  /** The real product-line name after B0-830's ProdLineDescr fix (was the marketing title). */
  const AF79_LINE_NAME = 'AF79 Concentrate Disinfectant';
  const match = { askedForName: AG79_ASKED_FOR, resolvedTitle: AF79_LINE_NAME };

  it('rewrites the full asked-for name everywhere in the body, including a fabricated Source line', () => {
    // Verbatim shape from live run a909277f / 9763a3a8 (2026-09-03).
    const draft = [
      'The dilution rate for AG79 Concentrate Disinfectant (Concentrated Acid Free Bathroom Disinfectant) is 1:4.',
      '',
      'Source: AG79 Concentrate Disinfectant product label; Betco verified efficacy data.',
    ].join('\n');

    const out = rewriteAskedForNameToResolved(draft, match);

    expect(out).not.toMatch(/AG79/);
    expect(out).toContain('The dilution rate for AF79 Concentrate Disinfectant (Concentrated');
    expect(out).toContain('Source: AF79 Concentrate Disinfectant product label');
    // The regulated value itself is untouched.
    expect(out).toContain('is 1:4.');
  });

  it('rewrites the bare misspelled product code when the resolved name has exactly one code token', () => {
    const out = rewriteAskedForNameToResolved(
      'AG79 is diluted at 1:4. Use AG79 in restrooms; ag79 is acid-free.',
      match,
    );
    expect(out).toBe('AF79 is diluted at 1:4. Use AF79 in restrooms; AF79 is acid-free.');
  });

  it('does NOT rewrite a bare code when the resolved name carries no code token to substitute', () => {
    const marketingTitleMatch = {
      askedForName: AG79_ASKED_FOR,
      resolvedTitle: 'Concentrated Acid Free Bathroom Disinfectant',
    };
    const out = rewriteAskedForNameToResolved(
      'AG79 Concentrate Disinfectant is acid-free. AG79 works in restrooms.',
      marketingTitleMatch,
    );
    // Full phrase still rewritten; the bare "AG79" is left alone rather than guessed at.
    expect(out).toBe(
      'Concentrated Acid Free Bathroom Disinfectant is acid-free. AG79 works in restrooms.',
    );
  });

  it('drops the tautological "(also known as <same name>)" the rewrite can produce', () => {
    // Live shape from run eb6b99af: the model wrote "AG79 … (also known as AF79 …)"; after the
    // rewrite both halves name the same product, so the parenthetical carries nothing.
    const out = rewriteAskedForNameToResolved(
      'The dilution rate for AG79 Concentrate Disinfectant (also known as AF79 Concentrate Disinfectant) is 1:4.',
      match,
    );
    expect(out).toBe('The dilution rate for AF79 Concentrate Disinfectant is 1:4.');
    // A parenthetical that adds a DIFFERENT name is kept.
    const kept = rewriteAskedForNameToResolved(
      'AG79 Concentrate Disinfectant (also known as Concentrated Acid Free Bathroom Disinfectant) is 1:4.',
      match,
    );
    expect(kept).toBe(
      'AF79 Concentrate Disinfectant (also known as Concentrated Acid Free Bathroom Disinfectant) is 1:4.',
    );
  });

  it('never rewrites a bare token that is part of a longer word', () => {
    const out = rewriteAskedForNameToResolved('The XAG79Y code is unrelated.', match);
    expect(out).toBe('The XAG79Y code is unrelated.');
  });

  it("protects the QUOTED asked-for name — the disclosure must keep naming what the user typed", () => {
    const selfDisclosed = `I couldn't find an exact match for "AG79 Concentrate Disinfectant", but found AF79 Concentrate Disinfectant. AG79 Concentrate Disinfectant is diluted 1:4.`;
    const out = rewriteAskedForNameToResolved(selfDisclosed, match);
    expect(out).toBe(
      `I couldn't find an exact match for "AG79 Concentrate Disinfectant", but found AF79 Concentrate Disinfectant. AF79 Concentrate Disinfectant is diluted 1:4.`,
    );
  });

  it('is a no-op when the asked-for and resolved names are the same text', () => {
    const draft = 'AF79 Concentrate Disinfectant is diluted 1:4.';
    expect(
      rewriteAskedForNameToResolved(draft, {
        askedForName: 'af79 concentrate disinfectant',
        resolvedTitle: AF79_LINE_NAME,
      }),
    ).toBe(draft);
  });

  it('maybeDiscloseAliasFuzzyMatch still fixes the body when the model disclosed on its own', () => {
    const selfDisclosed = `I couldn't find an exact match for "${AG79_ASKED_FOR}", but found ${AF79_LINE_NAME}.\n\nAG79 Concentrate Disinfectant is diluted 1:4.\n\nSource: AG79 Concentrate Disinfectant product label.`;
    const out = maybeDiscloseAliasFuzzyMatch(selfDisclosed, [
      efficacyToolOutput({
        askedFor: AG79_ASKED_FOR,
        outcome: 'alias_fuzzy',
        matchedTitle: AF79_LINE_NAME,
      }),
    ]);
    // No second disclosure, no invite (the model already disclosed) — but the body is corrected.
    expect(out.match(/couldn't find an exact match/g)).toHaveLength(1);
    expect(out).not.toContain(ALIAS_FUZZY_CORRECTION_INVITE.trim());
    expect(out).toContain(`"${AG79_ASKED_FOR}"`);
    expect(out).toContain('AF79 Concentrate Disinfectant is diluted 1:4.');
    expect(out).toContain('Source: AF79 Concentrate Disinfectant product label.');
  });

  it('end-to-end AG79 repro: disclosure + corrected body + invite', () => {
    const draft =
      'The dilution rate for AG79 Concentrate Disinfectant is 1:4 (32 oz/gal).\n\nSource: AG79 Concentrate Disinfectant product label.';
    const out = maybeDiscloseAliasFuzzyMatch(draft, [
      efficacyToolOutput({
        askedFor: AG79_ASKED_FOR,
        outcome: 'alias_fuzzy',
        matchedTitle: AF79_LINE_NAME,
      }),
    ]);
    expect(out.startsWith(`I couldn't find an exact match for "${AG79_ASKED_FOR}", but found ${AF79_LINE_NAME}`)).toBe(true);
    expect(out).toContain('The dilution rate for AF79 Concentrate Disinfectant is 1:4 (32 oz/gal).');
    expect(out).toContain('Source: AF79 Concentrate Disinfectant product label.');
    expect(out.endsWith(ALIAS_FUZZY_CORRECTION_INVITE)).toBe(true);
    // The only remaining "AG79" is the quoted asked-for name inside the disclosure.
    expect(out.match(/AG79/g)).toHaveLength(1);
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
