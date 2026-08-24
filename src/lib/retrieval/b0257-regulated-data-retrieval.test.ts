import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  fetchFactsForProductLineKey,
  fetchFactsForProductLineKeys,
} from '~/lib/retrieval/product-facts';
import {
  fetchDiscontinuedEntityIds,
  ragQueryForProductKnowledgeWithMeta,
} from '~/lib/retrieval/product-knowledge';

/**
 * B0-257 work items 2 & 4 — live-DB verification (same "load .env.local, skip
 * gracefully without creds" convention as rag/efficacy-retrieval-lifecycle.test.ts,
 * since these exercise real Supabase data rather than mocks):
 *   - get_efficacy_data's exact dilution/contact-time lookup (fetchFactsForProductLineKey)
 *     against real product lines with known-good data, including the newly-surfaced
 *     `confidence` column.
 *   - the discontinued-product retrieval filter (fetchDiscontinuedEntityIds) against a
 *     real discontinued entity ("pH7Q") and a real active one.
 *
 * Values below were read directly from rag.product_line_fact / rag.product_efficacy /
 * rag.entity via mcp__supabase__execute_sql and are transcribed verbatim (never
 * rounded/converted). Test subjects were deliberately chosen to be genuine
 * entity_type='product_line' rows with product_key IS NULL facts -- an earlier pass at
 * writing this test picked "Sure Bet II" / "Tile Clean" by product_line_key, which turned
 * out to be product-TIER-only entities (product_key set) sharing that product_line_key
 * with a *different* product_line-tier entity, so the lookup silently returned a
 * different, real-but-wrong line's numbers instead of failing loudly. That mismatch is
 * itself evidence of a real gap -- see the "KNOWN GAP" test below.
 */

function loadEnvLocalIfNeeded() {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return;
  }
  const envPath = path.resolve(__dirname, '../../../.env.local');
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvLocalIfNeeded();

const hasSupabaseCreds = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

describe.skipIf(!hasSupabaseCreds)('get_efficacy_data exact lookup — real product lines (B0-257)', () => {
  it('"High Power" — exact dilution display + sub-1.0 confidence surfaced (not a guessed value)', async () => {
    const facts = await fetchFactsForProductLineKey('A133D119-D145-4192-B560-06EA25A8F16C');
    expect(facts).not.toBeNull();
    expect(facts?.dilutionDisplay).toBe('10 oz. /gal.');
    expect(facts?.dilutionOzPerGal).toBe(10);
    expect(facts?.confidence).toBe(0.75);
  });

  it('"Floor Neutralizer and Cleaner/Ice Melt Remover" — exact dilution + coverage, confidence 1.0', async () => {
    const facts = await fetchFactsForProductLineKey('388940C9-E83D-4967-8F9F-EDD51383067C');
    expect(facts).not.toBeNull();
    expect(facts?.dilutionDisplay).toBe('1:64');
    expect(facts?.dilutionOzPerGal).toBe(2);
    expect(facts?.coverageSqFt).toBe(500);
    expect(facts?.confidence).toBe(1);
  });

  it('"DefenderT Linoleum System Stripper" — exact dilution + coverage, confidence 1.0', async () => {
    const facts = await fetchFactsForProductLineKey('1F8FDA26-18C0-41E6-93B8-38E3E36FDABD');
    expect(facts).not.toBeNull();
    expect(facts?.dilutionDisplay).toBe('1:10');
    expect(facts?.dilutionOzPerGal).toBe(12.8);
    expect(facts?.coverageSqFt).toBe(400);
    expect(facts?.confidence).toBe(1);
  });

  it('returns null (not a guess) for a random/unknown product line key', async () => {
    const facts = await fetchFactsForProductLineKey('00000000-0000-0000-0000-000000000000');
    expect(facts).toBeNull();
  });

  it('"Pearlescent Antibacterial Lotion Skin Cleanser" — real per-organism kill claims reachable at the line level', async () => {
    const facts = await fetchFactsForProductLineKey('0915A480-8E11-47C8-8C30-FF08455B9E1D');
    expect(facts).not.toBeNull();
    const salmonella = facts?.efficacy.find((e) => e.organism === 'Salmonella enterica');
    expect(salmonella?.contactTimeSeconds).toBe(60);
    expect(salmonella?.claimType).toBe('time_kill');
    expect(salmonella?.confidence).toBe(1);
  });

  it(
    'GAP NOW CLOSED BY B0-634 (was a documented KNOWN GAP here): kill-claim data keyed to a ' +
      'product-TIER entity (rag.product_efficacy) used to be invisible to this product-LINE-keyed ' +
      'lookup. "Oxy Fight Bac RTU" carries real bactericidal/fungicidal/virucidal claims ' +
      '(contact_time_seconds=600, EPA 85837-4-4170, confidence 0.9) on its product-tier entity and ' +
      'none on its product_line-tier sibling, so this returned null. B0-634 unions efficacy rows ' +
      'across both tiers, so those verified claims now reach get_efficacy_data.',
    async () => {
      const facts = await fetchFactsForProductLineKey('63A713FE-F46F-49F0-80A7-A61D4D2F25C5');
      expect(facts).not.toBeNull();
      const staph = facts?.efficacy.find((e) => e.organism === 'Staphylococcus aureus');
      expect(staph?.claimType).toBe('bactericidal');
      expect(staph?.contactTimeSeconds).toBe(600);
      expect(staph?.epaRegistration).toBe('85837-4-4170');
      expect(staph?.confidence).toBe(0.9);
    },
  );
});

/**
 * B0-634 — tier-aware fact resolution. `get_efficacy_data` for "Push" returned
 * dilutionOzPerGal: null even though rag.product_line_fact holds dilution_oz_per_gal = 5 for it,
 * because the resolver only ever read the product_line-TIER entity. Line keys / values below were
 * read live via mcp__supabase__execute_sql and are transcribed verbatim. Merge-rule unit coverage
 * (agree / disagree / union) lives in b0634-cross-tier-facts.test.ts.
 */
describe.skipIf(!hasSupabaseCreds)('cross-tier fact resolution — real product lines (B0-634)', () => {
  it('"Push" — product-tier dilution_oz_per_gal = 5 now reaches the line-keyed lookup', async () => {
    const facts = await fetchFactsForProductLineKey('F831DAC3-288E-4013-AE36-D0141F8F94F1');
    expect(facts).not.toBeNull();
    // product-tier entities "Push" (13304) and "Push Mango" (260804) both store 5 -> they agree.
    expect(facts?.dilutionOzPerGal).toBe(5);
    // line-tier scalars are untouched by the merge
    expect(facts?.coverageSqFt).toBe(3200);
    expect(facts?.productApplication).toBe('drain-maintenance, general-cleaner');
    expect(facts?.confidence).toBe(1);
  });

  it('"Aggressive No-Rinse Stripper" — a non-null line-tier value is never overwritten by the product tier', async () => {
    // product-tier rows carry dilution_display "1:3" and "Normal stripping — 1:10"; the line tier
    // has "13 oz./gal." and must win outright.
    const facts = await fetchFactsForProductLineKey('75FCC5DE-ECD2-4AD3-8117-3A397A3A916D');
    expect(facts).not.toBeNull();
    expect(facts?.dilutionDisplay).toBe('13 oz./gal.');
    expect(facts?.dilutionOzPerGal).toBe(13);
    expect(facts?.confidence).toBe(0.75);
  });

  it('"Super Concentrated Industrial Degreaser" — disagreeing product-tier dilutions abstain rather than pick one', async () => {
    // Two product-tier fact rows, dilution_display "1:22" (58864) vs "1:100" (SP58864), and no
    // line-tier fact row at all. Differing dilutions mean different formulations, so the merge
    // must leave every scalar null -- which leaves nothing on file and returns null, not a guess.
    const facts = await fetchFactsForProductLineKey('5C84E6CF-449C-4B3C-A058-145FE28122FA');
    expect(facts).toBeNull();
  });

  it('batch resolver agrees with the single-key resolver on the "Push" line', async () => {
    const batch = await fetchFactsForProductLineKeys([
      'F831DAC3-288E-4013-AE36-D0141F8F94F1',
      '5C84E6CF-449C-4B3C-A058-145FE28122FA',
    ]);
    expect(batch.get('F831DAC3-288E-4013-AE36-D0141F8F94F1')?.dilutionOzPerGal).toBe(5);
    // abstained line carries no facts at all -> absent from the map, never a placeholder
    expect(batch.has('5C84E6CF-449C-4B3C-A058-145FE28122FA')).toBe(false);
  });
});

describe.skipIf(!hasSupabaseCreds)('discontinued-product retrieval filter (B0-257 work item 4)', () => {
  it('flags the real discontinued "pH7Q" entity', async () => {
    const discontinued = await fetchDiscontinuedEntityIds([
      '2ef75e14-38a7-5727-98b3-a5f4d5ee28ea', // pH7Q — verified live: metadata->>'status' = 'discontinued'
    ]);
    expect(discontinued.has('2ef75e14-38a7-5727-98b3-a5f4d5ee28ea')).toBe(true);
  });

  it('does not flag an id with no discontinued status', async () => {
    const discontinued = await fetchDiscontinuedEntityIds([
      '00000000-0000-0000-0000-000000000000',
    ]);
    expect(discontinued.size).toBe(0);
  });

  it('degrades to an empty set (no filter) for an empty input rather than querying', async () => {
    const discontinued = await fetchDiscontinuedEntityIds([]);
    expect(discontinued.size).toBe(0);
  });
});

const hasOpenAiCreds = Boolean(process.env.OPENAI_API_KEY);

describe.skipIf(!hasSupabaseCreds || !hasOpenAiCreds)(
  'retrieval citations carry source S3 key/URI (B0-257 work item 3) — live semantic search',
  () => {
    it('a claim-like query for "Kling" surfaces its label with s3Key/sourceUri populated', async () => {
      // Kling — a real product line with a Phase-1-linked label document (verified live).
      const result = await ragQueryForProductKnowledgeWithMeta({
        query: 'Kling dilution ratio directions for use',
        productLineKey: '110F65B0-FE92-412A-9A03-654586617F2C',
      });

      const labelSource = result.sources.find((s) => s.documentKind === 'label');
      expect(labelSource).toBeDefined();
      expect(labelSource?.s3Key).toBe('labels/betco/07512_kling.md');
      expect(labelSource?.sourceUri).toBe('s3://retool-360/labels/betco/07512_kling.md');
    }, 30_000);
  },
);
