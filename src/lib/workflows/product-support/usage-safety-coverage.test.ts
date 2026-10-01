import { describe, expect, it } from 'vitest';

import type { ProductLineLock, ToolTraceEntry } from '~/lib/audit/trace';
import {
  evaluateUsageSafetyCoverage,
  hasUsageSafetyQuestionShape,
  isSafetySensitiveRoute,
  queryNeedsUsageAndSafetyCoverage,
  resolveUsageSafetyProductSubject,
} from '~/lib/workflows/product-support/run-product-support-workflow';

/**
 * B0-365 — the usage/safety coverage gate clamps confidence to 0.55 and marks the
 * answer unapproved. It used to scan only `title` + `snippet`, while
 * `search_product_docs` returns full documents ("read documentBody, not just
 * snippet") and the agent answers from that body — so grounded answers were clamped.
 *
 * The gate itself is unchanged: no usage/safety evidence in ANY field still means no
 * coverage. Only the fields it looks at widened.
 */

type CoverageSource = Parameters<typeof evaluateUsageSafetyCoverage>[0][number];

function source(overrides: Partial<CoverageSource> = {}): CoverageSource {
  return {
    title: 'Betco pH7Q Dual Product Sheet',
    snippet: 'A neutral disinfectant cleaner concentrate.',
    documentBody: '',
    documentKind: 'label',
    ...overrides,
  };
}

describe('evaluateUsageSafetyCoverage — evidence in documentBody only', () => {
  it('finds usage and safety evidence that appears only in the document body', () => {
    expect(
      evaluateUsageSafetyCoverage([
        source({
          title: 'Betco pH7Q Dual',
          snippet: 'Neutral disinfectant cleaner concentrate for hard surfaces.',
          documentBody: [
            'Directions for Use: dilute 1/2 oz per gallon of water.',
            'Precautionary statements: wear protective eyewear. Hazard: causes eye irritation.',
          ].join('\n'),
        }),
      ]),
    ).toEqual({ hasUsageEvidence: true, hasSafetyEvidence: true });
  });

  it('still finds usage-only evidence in the body without inventing safety coverage', () => {
    expect(
      evaluateUsageSafetyCoverage([
        source({
          title: 'Betco Fight Bac RTU',
          snippet: 'Ready-to-use product overview.',
          documentBody: 'Application: spray onto the surface and allow to remain wet.',
        }),
      ]),
    ).toEqual({ hasUsageEvidence: true, hasSafetyEvidence: false });
  });

  it('scans at most the first 4,000 chars of a body (signal past the cap is not read)', () => {
    const padded = `${'q'.repeat(4_200)} first aid: rinse with water`;
    expect(
      evaluateUsageSafetyCoverage([
        source({ title: 'Filler', snippet: 'Filler.', documentBody: padded }),
      ]),
    ).toEqual({ hasUsageEvidence: false, hasSafetyEvidence: false });

    expect(
      evaluateUsageSafetyCoverage([
        source({
          title: 'Filler',
          snippet: 'Filler.',
          documentBody: `first aid: rinse with water ${padded}`,
        }),
      ]),
    ).toEqual({ hasUsageEvidence: false, hasSafetyEvidence: true });
  });
});

describe('evaluateUsageSafetyCoverage — genuinely no evidence still reports none', () => {
  it('reports no coverage when title, snippet and body all lack usage/safety text', () => {
    expect(
      evaluateUsageSafetyCoverage([
        source({
          title: 'Betco Corporate Overview',
          snippet: 'Betco is headquartered in Toledo, Ohio.',
          documentBody: 'Founded in 1950. Manufacturing and distribution footprint.',
          documentKind: 'other',
        }),
      ]),
    ).toEqual({ hasUsageEvidence: false, hasSafetyEvidence: false });
  });

  it('reports no coverage for an empty source list', () => {
    expect(evaluateUsageSafetyCoverage([])).toEqual({
      hasUsageEvidence: false,
      hasSafetyEvidence: false,
    });
  });

  it('keeps the documentKind shortcuts (sds ⇒ safety, product_line_profile ⇒ usage)', () => {
    expect(
      evaluateUsageSafetyCoverage([
        source({ title: 'x', snippet: 'y', documentBody: '', documentKind: 'sds' }),
      ]),
    ).toEqual({ hasUsageEvidence: false, hasSafetyEvidence: true });

    expect(
      evaluateUsageSafetyCoverage([
        source({
          title: 'x',
          snippet: 'y',
          documentBody: '',
          documentKind: 'product_line_profile',
        }),
      ]),
    ).toEqual({ hasUsageEvidence: true, hasSafetyEvidence: false });
  });
});

/* -------------------------------------------------------------------------- *
 * B0-872 — the gate's TRIGGER: usage/safety question shape AND a product subject
 * -------------------------------------------------------------------------- */

/**
 * The five golden items the pre-B0-872 predicate mis-fired on (Dilution Control Top 20 #9, #10,
 * #11, #13 and SportsZone #21 — prompt texts verbatim from `public.test_items`). Every one is a
 * knowledge-base question that names no Betco product, retrieved only knowledge docs, and had
 * its 1,200–2,400 char draft replaced by the "Exact Betco product name or SKU" template.
 */
const KNOWLEDGE_QUESTIONS_WITHOUT_PRODUCT = [
  "Can dilution control work in areas that don't have direct water access?",
  'Do dilution control systems require plumbing or electrical work?',
  'Are there special plumbing approvals needed for a dilution control system?',
  'What factors can throw off the dilution accuracy in these systems?',
  'Can I use a disinfectant or bleach to sanitize our wood gym floor?',
];

const NO_PRODUCT_SUBJECT = { hasProductSubject: false as const };
const WITH_PRODUCT_SUBJECT = { hasProductSubject: true as const };

const emptyLock = (lockReason: ProductLineLock['lockReason']): ProductLineLock => ({
  candidates: [],
  lockedProductLineKey: null,
  lockReason,
});

function traceEntry(toolName: string, args: Record<string, unknown>): ToolTraceEntry {
  return {
    toolName,
    callId: `call_${toolName}`,
    ok: true,
    argumentsPreview: JSON.stringify(args),
    outputPreview: '{}',
    origin: 'model',
  } as ToolTraceEntry;
}

describe('hasUsageSafetyQuestionShape (B0-872)', () => {
  it('no longer fires on bare "dilution" or "application"', () => {
    expect(hasUsageSafetyQuestionShape('What is dilution control and why is it important?')).toBe(
      false,
    );
    expect(
      hasUsageSafetyQuestionShape('What factors can throw off the dilution accuracy in these systems?'),
    ).toBe(false);
    expect(hasUsageSafetyQuestionShape('What is the application rate for floor finish?')).toBe(false);
  });

  it('still fires on explicit usage and safety phrasing', () => {
    expect(hasUsageSafetyQuestionShape('How do I use pH7Q on a hospital floor?')).toBe(true);
    expect(hasUsageSafetyQuestionShape('Is it safe to use Fight Bac RTU around food?')).toBe(true);
    expect(hasUsageSafetyQuestionShape('What PPE do I need for Quat-Stat 5?')).toBe(true);
    expect(hasUsageSafetyQuestionShape('First aid if pH7Q gets in my eyes?')).toBe(true);
    // The "can i use <product> on" shape is kept — the product-subject half decides whether it applies.
    expect(hasUsageSafetyQuestionShape('Can I use a disinfectant or bleach to sanitize our wood gym floor?')).toBe(true);
  });
});

describe('resolveUsageSafetyProductSubject (B0-872)', () => {
  it('is false for the live shape of the five golden misses: no lock, no signals key, freeformQuery-only search', () => {
    for (const lockReason of [
      'skipped_no_product_line',
      'skipped_ambiguous',
      'skipped_low_confidence',
    ] as const) {
      expect(
        resolveUsageSafetyProductSubject({
          productLineLock: emptyLock(lockReason),
          signalsProductLineKey: null,
          toolTrace: [
            traceEntry('search_product_docs', {
              freeformQuery: 'Do dilution control systems require plumbing or electrical work?',
            }),
            traceEntry('get_efficacy_data', { category: 'dilution control systems' }),
          ],
        }),
      ).toEqual({ hasProductSubject: false, source: null });
    }
  });

  it('is true from a non-null product-line lock', () => {
    expect(
      resolveUsageSafetyProductSubject({
        productLineLock: {
          candidates: [{ productLineKey: 'ph7q-dual', label: 'pH7Q Dual', maxSimilarity: 0.91 }],
          lockedProductLineKey: 'ph7q-dual',
          lockReason: 'explicit_filter',
          explicitKeySource: 'alias_exact',
        },
        signalsProductLineKey: null,
        toolTrace: [],
      }),
    ).toEqual({ hasProductSubject: true, source: 'product_line_lock' });
  });

  it('is true from the signals pass having resolved a product entity', () => {
    expect(
      resolveUsageSafetyProductSubject({
        productLineLock: null,
        signalsProductLineKey: 'ph7q-dual',
        toolTrace: [],
      }),
    ).toEqual({ hasProductSubject: true, source: 'turn_signals' });
  });

  it('is true when a search-backed tool call named a product (productName), and ignores non-search tools', () => {
    expect(
      resolveUsageSafetyProductSubject({
        productLineLock: null,
        signalsProductLineKey: null,
        toolTrace: [traceEntry('search_product_docs', { productName: 'pH7Q Dual', topic: 'tile' })],
      }),
    ).toEqual({ hasProductSubject: true, source: 'tool_arguments' });

    expect(
      resolveUsageSafetyProductSubject({
        productLineLock: null,
        signalsProductLineKey: null,
        toolTrace: [
          traceEntry('lookup_cross_reference', { productName: 'BNC-15' }),
          traceEntry('search_product_docs', { productName: '   ' }),
        ],
      }),
    ).toEqual({ hasProductSubject: false, source: null });
  });

  it('treats an unparseable (truncated) arguments preview as no evidence rather than guessing', () => {
    expect(
      resolveUsageSafetyProductSubject({
        productLineLock: null,
        signalsProductLineKey: null,
        toolTrace: [
          { ...traceEntry('search_product_docs', {}), argumentsPreview: '{"productName":"pH7Q' },
        ],
      }),
    ).toEqual({ hasProductSubject: false, source: null });
  });
});

describe('queryNeedsUsageAndSafetyCoverage (B0-872)', () => {
  it.each(KNOWLEDGE_QUESTIONS_WITHOUT_PRODUCT)(
    'does not require usage/safety coverage for the product-less knowledge question: %s',
    (question) => {
      expect(queryNeedsUsageAndSafetyCoverage(question, NO_PRODUCT_SUBJECT)).toBe(false);
    },
  );

  it('still requires coverage for a usage question about an identified product', () => {
    expect(
      queryNeedsUsageAndSafetyCoverage('How do I use pH7Q on a hospital floor?', WITH_PRODUCT_SUBJECT),
    ).toBe(true);
    expect(
      queryNeedsUsageAndSafetyCoverage('Can I use pH7Q Dual on a wood gym floor?', WITH_PRODUCT_SUBJECT),
    ).toBe(true);
  });

  it('does not require coverage for a product question that is not about usage or safety', () => {
    expect(
      queryNeedsUsageAndSafetyCoverage(
        'What is the EPA reg number for Betco Fight Bac RTU?',
        WITH_PRODUCT_SUBJECT,
      ),
    ).toBe(false);
  });

  it('keeps the broad pre-B0-872 reading for the validator-skip route: a dilution-shaped question is still safety-sensitive', () => {
    // `isSafetySensitiveRoute` deliberately kept bare `dilution` (B0-546): narrowing the coverage
    // gate must not let dilution questions skip the validator on similarity grounds.
    expect(
      isSafetySensitiveRoute('What factors can throw off the dilution accuracy in these systems?', 'product'),
    ).toBe(true);
    expect(isSafetySensitiveRoute('Do dilution control systems require plumbing or electrical work?', 'product')).toBe(true);
    // ...while a message with none of the broad terms is still not safety-sensitive on its own.
    expect(isSafetySensitiveRoute('How does a proportioner mount to the wall?', 'product')).toBe(false);
  });
});
