import { describe, expect, it, vi } from 'vitest';

/**
 * B0-484 — regression coverage for the precision guards in
 * scripts/mine-corpus-alias-candidates.mjs. These guards are the only thing standing between
 * the corpus_scan_* candidate pipeline and a flood of junk rows landing in rag.product_alias
 * (verified=false, awaiting human review at B0-487).
 *
 * Placement: the script under test lives at scripts/mine-corpus-alias-candidates.mjs, outside
 * src/, but vitest.config.ts only collects `src/**\/*.test.ts`. This file lives under
 * src/scripts/ purely so a bare `pnpm exec vitest run` picks it up; it imports the real script
 * by relative path below.
 *
 * Import hazard (see final report): the script calls `main()` unconditionally at module scope —
 * there is no `import.meta.url === process.argv[1]` entrypoint guard (none of its scripts/*.mjs
 * siblings have one either, so this is a repo-wide pattern, not unique to this file). A plain
 * `import` of the module would therefore, on every test run:
 *   - read real credentials from .env.local if present, or otherwise hard-fail via
 *     `process.exit(1)` (killing the entire vitest process, not just this file) — so behavior
 *     would differ between a laptop with .env.local and CI without one;
 *   - make live Supabase reads against whatever project those credentials point to;
 *   - and, because `--dry-run` is never present in *this* process's argv, go on to call
 *     `safeUpsertCandidates()` and actually INSERT/UPDATE rows in rag.product_alias.
 * That's a genuine testability gap in the script, not something this test file silently works
 * around by changing the script's logic. Instead: force `--dry-run` onto process.argv and stub
 * out '@supabase/supabase-js' with an always-empty query builder before importing, so `main()`
 * runs to completion as a total no-op with zero network activity, and the individually exported
 * guard functions become safely importable for direct testing.
 */

const ORIGINAL_ARGV = process.argv;
process.argv = [...ORIGINAL_ARGV, '--dry-run'];
if (!process.env.NEXT_PUBLIC_SUPABASE_URL) process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.invalid';
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only-placeholder-key';

vi.mock('@supabase/supabase-js', () => {
  const emptyBuilder: Record<string, unknown> = {};
  const chain = () => emptyBuilder;
  emptyBuilder.select = chain;
  emptyBuilder.range = chain;
  emptyBuilder.in = chain;
  emptyBuilder.not = chain;
  emptyBuilder.eq = chain;
  emptyBuilder.then = (resolve: (result: { data: unknown[]; error: null }) => unknown) =>
    resolve({ data: [], error: null });
  return {
    createClient: () => ({
      schema: () => ({ from: () => emptyBuilder }),
    }),
  };
});

const scriptModule = await import('../../scripts/mine-corpus-alias-candidates.mjs');
process.argv = ORIGINAL_ARGV;

type AliasCandidate = {
  alias: string;
  aliasNorm: string;
  source: string;
  confidence: number;
};

const {
  maskIdentifiers,
  matchesTitleInitials,
  detectParenthetical,
  detectCooccurrence,
  detectNounPhraseVariants,
  significantTitleTokens,
} = scriptModule as unknown as {
  maskIdentifiers: (text: string) => string;
  matchesTitleInitials: (token: string, title: string) => boolean;
  detectParenthetical: (
    records: { text: string; entityId: string; productLineKey: string }[],
    entityTitleTokens: Map<string, string[]>,
  ) => AliasCandidate[];
  detectCooccurrence: (
    records: { text: string; entityId: string; productLineKey: string }[],
    entityTitleTokens: Map<string, string[]>,
    excludeKeys: Set<string>,
    entities: Map<string, { title: string }>,
  ) => AliasCandidate[];
  detectNounPhraseVariants: (
    entities: Map<string, { title: string; productLineKey: string }>,
    recordsByEntity: Map<string, { text: string }[]>,
  ) => AliasCandidate[];
  significantTitleTokens: (title: string) => string[];
};

describe('maskIdentifiers (B0-484 guard: strip GUIDs/SKU identifiers before mining)', () => {
  it('strips a full GUID so its alpha-only segments cannot survive as bare all-caps tokens', () => {
    const text =
      'Product line profile.\nProduct key: ABDA1234-CEEB-4DEF-BDFC-0123456789AB\nMore copy follows.';
    const masked = maskIdentifiers(text);
    expect(masked).not.toContain('ABDA1234-CEEB-4DEF-BDFC-0123456789AB');
    expect(masked).not.toMatch(/\bABDA\b/);
    expect(masked).not.toMatch(/\bCEEB\b/);
    expect(masked).not.toMatch(/\bBDFC\b/);
    expect(masked).toContain('More copy follows.');
  });

  it('strips a labelled "Product key:" line entirely', () => {
    const masked = maskIdentifiers(
      'Product key: AAAA1111-BBBB-2222-CCCC-333344445555\nUnrelated text.',
    );
    expect(masked).not.toMatch(/product key/i);
    expect(masked).toContain('Unrelated text.');
  });

  it('strips bare SKU-shaped codes like A123456 / BF123456', () => {
    const masked = maskIdentifiers('Also stocked under code A123456 and code BF123456 for wholesale.');
    expect(masked).not.toContain('A123456');
    expect(masked).not.toContain('BF123456');
  });
});

describe("matchesTitleInitials (B0-484 guard: token must be initials of a run of the title's own words)", () => {
  const unrelatedTitle = 'Hard As Nails';

  it.each(['MRSA', 'HBV', 'PSI', 'CFU', 'EPA'])('rejects %s against an unrelated product title', (token) => {
    expect(matchesTitleInitials(token, unrelatedTitle)).toBe(false);
  });

  it('accepts a token that genuinely is the initials of the title', () => {
    expect(matchesTitleInitials('HAN', unrelatedTitle)).toBe(true);
  });
});

describe('detectParenthetical (B0-484 guard: "Phrase (ACRONYM)" + title-vocab overlap)', () => {
  it('rejects "Hepatitis B Virus (HBV)" appearing in copy for an unrelated product', () => {
    const entityTitleTokens = new Map([['ent-han', significantTitleTokens('Hard As Nails')]]);
    const records = [
      {
        text: 'Effective against Hepatitis B Virus (HBV) on hard nonporous surfaces.',
        entityId: 'ent-han',
        productLineKey: 'line-han',
      },
    ];
    expect(detectParenthetical(records, entityTitleTokens)).toEqual([]);
  });

  it("accepts a legitimate \"Phrase (ACRONYM)\" whose acronym is the phrase's initials and overlaps the product title", () => {
    const entityTitleTokens = new Map([['ent-han', significantTitleTokens('Hard As Nails')]]);
    // The phrase sits at the very start of the record text deliberately -- see the next test,
    // which documents a real recall bug this pattern has whenever the phrase is *not* first.
    const records = [
      {
        text: 'Hard As Nails (HAN) is our top wood floor finish.',
        entityId: 'ent-han',
        productLineKey: 'line-han',
      },
    ];
    const candidates = detectParenthetical(records, entityTitleTokens);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      alias: 'HAN',
      aliasNorm: 'han',
      source: 'corpus_scan_parenthetical',
      confidence: 0.65,
    });
  });

  /**
   * GENUINE FINDING (not a design choice being pinned down): PHRASE_ACRONYM_RE's `{1,5}`
   * repetition is greedy and unanchored, and `detectParenthetical`'s `while (PHRASE_ACRONYM_RE
   * .exec(...))` loop advances `lastIndex` past whatever span the regex consumed -- valid or
   * not -- with no retry at a shorter phrase boundary. So the very first regex match attempt
   * starting at or before the true phrase greedily swallows any preceding word(s) too (up to 5),
   * that longer phrase then fails the `initialsOf(phrase) === acronym` check, and the loop moves
   * on having permanently consumed (and never revisited) the substring containing the real
   * "Hard As Nails (HAN)" match. In practice this means a legitimate acronym-parenthetical is
   * only ever detected when it is the literal first thing in the scanned text -- one leading
   * word (e.g. "New Hard As Nails (HAN) formula.") is already enough to suppress it, and it does
   * not recover at sentence boundaries either (the char class includes `.`, so "See our lineup.
   * Hard As Nails (HAN)..." fails the same way). This is a real recall gap in the parenthetical
   * pattern for ordinary corpus prose, not a corner case -- see the accompanying report.
   */
  // Regression: the phrase used to be captured by a greedy {1,5} word-run, so a leading word made
  // the initials check fail ("New Hard As Nails" -> NHAN) with no retry at a shorter boundary, and
  // a valid "Phrase (ACRONYM)" was only detected when it began the text.
  it.each([
    ['a single leading word', 'New Hard As Nails (HAN) formula.'],
    ['a preceding sentence', 'See our lineup. Hard As Nails (HAN) is the flagship.'],
    ['mid-paragraph placement', 'Betco offers many finishes. We recommend Hard As Nails (HAN) here.'],
  ])('detects "Hard As Nails (HAN)" despite %s', (_label, text) => {
    const entityTitleTokens = new Map([['ent-han', significantTitleTokens('Hard As Nails')]]);
    const records = [{ text, entityId: 'ent-han', productLineKey: 'line-han' }];

    const found = detectParenthetical(records, entityTitleTokens);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ alias: 'HAN', aliasNorm: 'han', aliasType: 'acronym' });
    expect(found[0].evidence).toBe('"Hard As Nails (HAN)"');
  });

  it('does not let a phrase span a sentence boundary to manufacture a match', () => {
    const entityTitleTokens = new Map([['ent-han', significantTitleTokens('Hard As Nails')]]);
    // "Nails" ends the first sentence; only "Buff And Shine" precedes (BAS), so HAN must not match.
    const records = [
      {
        text: 'Apply Hard As Nails. Buff And Shine (HAN) later.',
        entityId: 'ent-han',
        productLineKey: 'line-han',
      },
    ];

    expect(detectParenthetical(records, entityTitleTokens)).toEqual([]);
  });
});

describe('detectCooccurrence (B0-484 guard: >=2 independent records + multi-word title anchor)', () => {
  it('rejects a token that only occurs in a single record', () => {
    const entityTitleTokens = new Map([['ent-hanf', significantTitleTokens('Hard As Nails Finish')]]);
    const entities = new Map([['ent-hanf', { title: 'Hard As Nails Finish' }]]);
    const records = [
      {
        text: 'Our Hard As Nails Finish is popular. Ask about HANF pricing.',
        entityId: 'ent-hanf',
        productLineKey: 'line-hanf',
      },
    ];
    expect(detectCooccurrence(records, entityTitleTokens, new Set<string>(), entities)).toEqual([]);
  });

  it('rejects a single-word title as a co-occurrence anchor', () => {
    const entityTitleTokens = new Map([['ent-elec', significantTitleTokens('Electrical')]]);
    const entities = new Map([['ent-elec', { title: 'Electrical' }]]);
    const records = [
      { text: 'Electrical parts ship in ELEC boxes today.', entityId: 'ent-elec', productLineKey: 'line-elec' },
      {
        text: 'ELEC inventory restocked for the Electrical catalog.',
        entityId: 'ent-elec',
        productLineKey: 'line-elec',
      },
    ];
    expect(detectCooccurrence(records, entityTitleTokens, new Set<string>(), entities)).toEqual([]);
  });

  it('accepts a token appearing in two independent records for a multi-word title', () => {
    const entityTitleTokens = new Map([['ent-hanf', significantTitleTokens('Hard As Nails Finish')]]);
    const entities = new Map([['ent-hanf', { title: 'Hard As Nails Finish' }]]);
    const records = [
      {
        text: 'Our Hard As Nails Finish is popular. Ask about HANF pricing.',
        entityId: 'ent-hanf',
        productLineKey: 'line-hanf',
      },
      {
        text: 'HANF ships nationwide. The Hard As Nails Finish formula cures fast.',
        entityId: 'ent-hanf',
        productLineKey: 'line-hanf',
      },
    ];
    const candidates = detectCooccurrence(records, entityTitleTokens, new Set<string>(), entities);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      alias: 'HANF',
      aliasNorm: 'hanf',
      source: 'corpus_scan_cooccurrence',
      confidence: 0.35,
    });
  });
});

describe('detectNounPhraseVariants (B0-484 guard: region/status + catalog-bucket exclusions)', () => {
  it('rejects a region/status-suffixed title', () => {
    const entities = new Map([
      ['ent-ndc', { title: 'Neutral Disinfectant Cleaner (Canada Only)', productLineKey: 'line-ndc' }],
    ]);
    const recordsByEntity = new Map([
      ['ent-ndc', [{ text: 'Ask your rep about Neutral Disinfectant Cleaner pricing today.' }]],
    ]);
    expect(detectNounPhraseVariants(entities, recordsByEntity)).toEqual([]);
  });

  it('rejects a catalog-bucket title', () => {
    const entities = new Map([['ent-raw', { title: 'Raw Materials (Internal Use)', productLineKey: 'line-raw' }]]);
    const recordsByEntity = new Map([
      ['ent-raw', [{ text: 'Ask about Raw Materials pricing for bulk orders.' }]],
    ]);
    expect(detectNounPhraseVariants(entities, recordsByEntity)).toEqual([]);
  });

  it('accepts a legitimate head-phrase with standalone corpus corroboration', () => {
    const entities = new Map([['ent-han2', { title: 'Hard As Nails - Satin', productLineKey: 'line-han2' }]]);
    const recordsByEntity = new Map([['ent-han2', [{ text: 'Our Hard As Nails coating cures overnight.' }]]]);
    const candidates = detectNounPhraseVariants(entities, recordsByEntity);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      alias: 'Hard As Nails',
      aliasNorm: 'hard as nails',
      source: 'corpus_scan_noun_phrase',
      confidence: 0.45,
    });
  });
});
