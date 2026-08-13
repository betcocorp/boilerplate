import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { fetchFactsForProductLineKey } from '~/lib/retrieval/product-facts';
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
    'KNOWN GAP (verified live, pre-existing, out of scope for this ticket): kill-claim data ' +
      'keyed to a product-TIER entity (rag.product_efficacy) is invisible to this product-LINE-' +
      'keyed lookup, even though real verified data exists for the line. "Oxy Fight Bac RTU" has ' +
      'real bactericidal/fungicidal claims (contact_time_seconds=600, EPA 85837-4-4170, confidence ' +
      '0.9) on its product-tier entity, but its product_line-tier sibling entity has none — so ' +
      'fetchFactsForProductLineKey (and therefore get_efficacy_data) returns null here instead of ' +
      'those verified facts. B0-250 explicitly scoped fact/efficacy lookups to product_line_key ' +
      'only; extending this to also resolve product-tier data is a real follow-up, not something ' +
      'this ticket silently fixes.',
    async () => {
      const facts = await fetchFactsForProductLineKey('63A713FE-F46F-49F0-80A7-A61D4D2F25C5');
      expect(facts).toBeNull();
    },
  );
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
