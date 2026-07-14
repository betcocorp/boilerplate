import { describe, expect, it } from 'vitest';

import {
  citationUrlsToSourceRefs,
  webResultsToSourceRefs,
} from '~/lib/websearch/web-sources';
import type { WebSearchResult } from '~/lib/websearch/websearch-schemas';

describe('webResultsToSourceRefs (WEB-6)', () => {
  it('maps results into external SourceRefs, dedupes, and caps at the limit', () => {
    const results: WebSearchResult[] = [
      { title: 'BNC-15 SDS', url: 'https://spartanchemical.com/bnc-15', snippet: 'quat...', score: 0.9 },
      { title: 'dup', url: 'https://spartanchemical.com/bnc-15', snippet: 'x', score: 0.5 },
      { title: '', url: 'https://epa.gov/6836-348', snippet: 'reg', score: 0.8, sourceDomain: 'epa.gov' },
    ];
    const refs = webResultsToSourceRefs(results, 4);
    expect(refs).toHaveLength(2); // deduped
    expect(refs[0]).toMatchObject({
      kind: 'external',
      url: 'https://spartanchemical.com/bnc-15',
      documentId: 'https://spartanchemical.com/bnc-15',
      title: 'BNC-15 SDS',
      similarity: 0.9,
    });
    expect(refs[1]?.title).toBe('epa.gov'); // falls back to sourceDomain when title is empty
  });
});

describe('citationUrlsToSourceRefs (WEB-6)', () => {
  it('maps bare URLs into external SourceRefs titled by hostname', () => {
    const refs = citationUrlsToSourceRefs([
      'https://www.betco.com/products/triforce',
      'https://www.betco.com/products/triforce',
      '',
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: 'external', title: 'betco.com' });
  });
});
