import { describe, expect, it } from 'vitest';

import { applyProductPageUrlCitationBackstop } from '~/lib/workflows/product-support/product-page-url-citation-backstop';
import type { SourceRef } from '~/lib/conversations/conversation-schemas';

const baseSource = (overrides: Partial<SourceRef> = {}): SourceRef => ({
  documentId: 'a0d9b2e7-5551-41c2-9c8b-359fc3333fac',
  title: 'AF 79 product label',
  snippet: 'snippet',
  ...overrides,
});

describe('applyProductPageUrlCitationBackstop', () => {
  it('attaches the url after the matching [doc:uuid] citation', () => {
    const sources = [
      baseSource({
        documentId: 'a0d9b2e7-5551-41c2-9c8b-359fc3333fac',
        url: 'https://www.betco.com/ProductsDetail?productID=5DA2C45A-E3EC-4693-902C-8589705D1E71',
      }),
    ];
    const result = applyProductPageUrlCitationBackstop({
      draftAnswer:
        'AF79 is a disinfectant.\n\nSource: AF 79 product label [doc:a0d9b2e7-5551-41c2-9c8b-359fc3333fac].',
      sources,
    });
    expect(result.applied).toBe(true);
    expect(result.answer).toBe(
      'AF79 is a disinfectant.\n\nSource: AF 79 product label ' +
        '[doc:a0d9b2e7-5551-41c2-9c8b-359fc3333fac] ' +
        '(https://www.betco.com/ProductsDetail?productID=5DA2C45A-E3EC-4693-902C-8589705D1E71).',
    );
  });

  it('does not attach a url when the source has none', () => {
    const sources = [baseSource({ url: undefined })];
    const draftAnswer =
      'Source: AF 79 product label [doc:a0d9b2e7-5551-41c2-9c8b-359fc3333fac].';
    const result = applyProductPageUrlCitationBackstop({ draftAnswer, sources });
    expect(result.applied).toBe(false);
    expect(result.answer).toBe(draftAnswer);
  });

  it('never attaches a url to the synthetic verified-facts citation', () => {
    const sources = [
      baseSource({ documentId: 'verified-facts', url: undefined, title: 'Verified Product Facts' }),
    ];
    const draftAnswer = 'Sources: Betco verified product facts [doc:verified-facts].';
    const result = applyProductPageUrlCitationBackstop({ draftAnswer, sources });
    expect(result.applied).toBe(false);
    expect(result.answer).toBe(draftAnswer);
  });

  it('attaches a url only once when the same document is cited twice', () => {
    const sources = [
      baseSource({
        documentId: 'a0d9b2e7-5551-41c2-9c8b-359fc3333fac',
        url: 'https://www.betco.com/ProductsDetail?productID=5DA2C45A-E3EC-4693-902C-8589705D1E71',
      }),
    ];
    const draftAnswer =
      'Per [doc:a0d9b2e7-5551-41c2-9c8b-359fc3333fac], AF79 is a disinfectant. ' +
      'Source: AF 79 product label [doc:a0d9b2e7-5551-41c2-9c8b-359fc3333fac].';
    const result = applyProductPageUrlCitationBackstop({ draftAnswer, sources });
    expect(result.applied).toBe(true);
    const occurrences = result.answer.match(/\(https:\/\/www\.betco\.com/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('is a no-op when no source has a url', () => {
    const sources = [baseSource({ url: undefined })];
    const draftAnswer = 'No citations here at all.';
    const result = applyProductPageUrlCitationBackstop({ draftAnswer, sources });
    expect(result).toEqual({ answer: draftAnswer, applied: false });
  });

  it('leaves an uncited source (no matching marker in the text) untouched', () => {
    const sources = [
      baseSource({
        documentId: 'a0d9b2e7-5551-41c2-9c8b-359fc3333fac',
        url: 'https://www.betco.com/ProductsDetail?productID=5DA2C45A-E3EC-4693-902C-8589705D1E71',
      }),
    ];
    const draftAnswer = 'AF79 is a disinfectant with no citation marker at all.';
    const result = applyProductPageUrlCitationBackstop({ draftAnswer, sources });
    expect(result.applied).toBe(false);
    expect(result.answer).toBe(draftAnswer);
  });
});
