import { describe, expect, it } from 'vitest';

import { applyProductPageUrlCitationBackstop } from '~/lib/workflows/product-support/product-page-url-citation-backstop';
import type { SourceRef } from '~/lib/conversations/conversation-schemas';

const PRODUCT_URL = 'https://www.betco.com/ProductsDetail?productID=5DA2C45A-E3EC-4693-902C-8589705D1E71';

const baseSource = (overrides: Partial<SourceRef> = {}): SourceRef => ({
  documentId: 'a0d9b2e7-5551-41c2-9c8b-359fc3333fac',
  title: 'AF 79 product label',
  snippet: 'snippet',
  ...overrides,
});

describe('applyProductPageUrlCitationBackstop', () => {
  it('converts a product_line_profile citation on the closing Sources line into a markdown link', () => {
    const sources = [
      baseSource({
        documentId: '5abed264-b024-43a0-aaf2-61f5dd67705d',
        documentKind: 'product_line_profile',
        url: PRODUCT_URL,
      }),
    ];
    const draftAnswer =
      'AF79 is a disinfectant.\n\n' +
      'Sources: AF 79 product label [doc:a0d9b2e7-5551-41c2-9c8b-359fc3333fac]; ' +
      'Acid Free Bathroom Cleaner product profile [doc:5abed264-b024-43a0-aaf2-61f5dd67705d]; ' +
      'Betco verified product facts [doc:verified-facts].';
    const result = applyProductPageUrlCitationBackstop({ draftAnswer, sources });
    expect(result.applied).toBe(true);
    expect(result.answer).toBe(
      'AF79 is a disinfectant.\n\n' +
        'Sources: AF 79 product label [doc:a0d9b2e7-5551-41c2-9c8b-359fc3333fac]; ' +
        `[Acid Free Bathroom Cleaner product profile](${PRODUCT_URL}); ` +
        'Betco verified product facts [doc:verified-facts].',
    );
  });

  it('does not link a label or sds source, even with a url on the SourceRef', () => {
    const sources = [
      baseSource({
        documentId: 'a0d9b2e7-5551-41c2-9c8b-359fc3333fac',
        documentKind: 'label',
        url: PRODUCT_URL,
      }),
      baseSource({
        documentId: 'sds-doc-id',
        documentKind: 'sds',
        url: PRODUCT_URL,
      }),
    ];
    const draftAnswer =
      'Sources: AF 79 product label [doc:a0d9b2e7-5551-41c2-9c8b-359fc3333fac]; ' +
      'AF 79 SDS [doc:sds-doc-id].';
    const result = applyProductPageUrlCitationBackstop({ draftAnswer, sources });
    expect(result.applied).toBe(false);
    expect(result.answer).toBe(draftAnswer);
  });

  it('never links the synthetic verified-facts citation', () => {
    const sources = [
      baseSource({
        documentId: 'verified-facts',
        documentKind: 'facts',
        url: undefined,
        title: 'Verified Product Facts',
      }),
    ];
    const draftAnswer = 'Sources: Betco verified product facts [doc:verified-facts].';
    const result = applyProductPageUrlCitationBackstop({ draftAnswer, sources });
    expect(result.applied).toBe(false);
    expect(result.answer).toBe(draftAnswer);
  });

  it('does not touch a [doc:uuid]-shaped marker inside the answer body, only the closing citation line', () => {
    const sources = [
      baseSource({
        documentId: '5abed264-b024-43a0-aaf2-61f5dd67705d',
        documentKind: 'product_line_profile',
        url: PRODUCT_URL,
      }),
    ];
    const draftAnswer =
      'Per [doc:5abed264-b024-43a0-aaf2-61f5dd67705d], AF79 is a disinfectant.\n\n' +
      'Sources: Acid Free Bathroom Cleaner product profile [doc:5abed264-b024-43a0-aaf2-61f5dd67705d].';
    const result = applyProductPageUrlCitationBackstop({ draftAnswer, sources });
    expect(result.applied).toBe(true);
    expect(result.answer).toBe(
      'Per [doc:5abed264-b024-43a0-aaf2-61f5dd67705d], AF79 is a disinfectant.\n\n' +
        `Sources: [Acid Free Bathroom Cleaner product profile](${PRODUCT_URL}).`,
    );
  });

  it('handles a bare "Source:" (singular) line with one citation', () => {
    const sources = [
      baseSource({
        documentId: '5abed264-b024-43a0-aaf2-61f5dd67705d',
        documentKind: 'product_line_profile',
        url: PRODUCT_URL,
      }),
    ];
    const draftAnswer =
      'Source: Acid Free Bathroom Cleaner product profile [doc:5abed264-b024-43a0-aaf2-61f5dd67705d].';
    const result = applyProductPageUrlCitationBackstop({ draftAnswer, sources });
    expect(result.applied).toBe(true);
    expect(result.answer).toBe(
      `Source: [Acid Free Bathroom Cleaner product profile](${PRODUCT_URL}).`,
    );
  });

  it('is a no-op when no source is a linkable kind with a url', () => {
    const sources = [baseSource({ documentKind: 'label', url: undefined })];
    const draftAnswer = 'Sources: AF 79 product label [doc:a0d9b2e7-5551-41c2-9c8b-359fc3333fac].';
    const result = applyProductPageUrlCitationBackstop({ draftAnswer, sources });
    expect(result).toEqual({ answer: draftAnswer, applied: false });
  });

  it('is a no-op when there is no closing citation line at all', () => {
    const sources = [
      baseSource({
        documentId: '5abed264-b024-43a0-aaf2-61f5dd67705d',
        documentKind: 'product_line_profile',
        url: PRODUCT_URL,
      }),
    ];
    const draftAnswer = 'No citation line here at all.';
    const result = applyProductPageUrlCitationBackstop({ draftAnswer, sources });
    expect(result).toEqual({ answer: draftAnswer, applied: false });
  });
});
