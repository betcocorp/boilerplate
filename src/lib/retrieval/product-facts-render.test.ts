import { describe, expect, it, vi } from 'vitest';

// `product-facts.ts` builds a Supabase client at import time in its fetchers; `buildFactsBlock` is
// pure, so the client is stubbed out and never called here.
vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => {
    throw new Error('buildFactsBlock must not touch the database');
  },
}));
vi.mock('~/lib/rag/entity-context', () => ({
  resolveEntityDisplayTitle: async () => null,
}));

import { buildFactsBlock, type ProductLineFacts } from '~/lib/retrieval/product-facts';

/**
 * B0-986 — `contact_time_seconds` is stored in seconds and rendered in seconds. The bare `60s`
 * suffix is replaced by `60 sec` (the same unit, spelled so the model quotes it unambiguously);
 * it is NEVER converted to minutes — that would be a unit conversion of a regulated value in text
 * the model goes on to quote to the user.
 */
describe('buildFactsBlock — contact time rendering (B0-986)', () => {
  const facts: ProductLineFacts = {
    entityId: 'entity-1',
    dilutionOzPerGal: null,
    dilutionDisplay: 'Ready to use',
    coverageSqFt: null,
    chemistryClass: null,
    productApplication: null,
    productApplicationConfidence: null,
    epaRegistration: '34810-35-4170',
    contactTimeSeconds: 60,
    confidence: 1,
    efficacy: [
      {
        organism: 'Listeria monocytogenes',
        claimType: 'bactericidal',
        dilutionOzPerGal: null,
        contactTimeSeconds: 600,
        epaRegistration: '34810 35 4170',
        confidence: 0.9,
      },
    ],
  };

  it('renders seconds as "N sec", never as minutes', () => {
    const block = buildFactsBlock(new Map([[facts.entityId, facts]]), new Map([[facts.entityId, 'GE Fight Bac RTU']]));
    expect(block).toContain('- **Contact time:** 60 sec');
    expect(block).toContain('600 sec contact');
    expect(block).not.toMatch(/\b60s\b|\b600s\b/);
    expect(block).not.toMatch(/\b1 min|\b10 min/);
  });
});
