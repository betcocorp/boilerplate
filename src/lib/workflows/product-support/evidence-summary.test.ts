import { describe, expect, it } from 'vitest';

import {
  buildEvidenceSummary,
  type RetrievedSourceMeta,
} from '~/lib/workflows/product-support/run-product-support-workflow';

/**
 * B0-885 — the validator/revision evidence summary must be built from the fuller
 * `documentBody` window the generator actually read, not the ~900-char retrieval-preview
 * `snippet`. Before this, a source with a short snippet and a much larger body still emitted
 * only the snippet, starving the validator of context the generator had and causing grounded
 * drafts to be rejected and rewritten thinner.
 */

function makeSource(overrides: Partial<RetrievedSourceMeta>): RetrievedSourceMeta {
  return {
    documentId: 'doc-1',
    chunkId: 'chunk-1',
    title: 'Sample Label',
    snippet: '',
    documentBody: '',
    documentKind: 'label',
    s3Key: null,
    sourceUri: null,
    ...overrides,
  };
}

describe('buildEvidenceSummary', () => {
  it('emits the fuller documentBody instead of a shorter snippet', () => {
    const snippet = 'Short retrieval preview.'.padEnd(300, ' x');
    const documentBody = 'Full generator evidence window. '.repeat(160); // ~5k chars
    const source = makeSource({ snippet, documentBody });

    const summary = buildEvidenceSummary([source]);

    expect(summary).toContain(documentBody.slice(0, 200));
    expect(summary).not.toContain(snippet);
  });

  it('falls back to snippet only when documentBody is empty', () => {
    const snippet = 'Only a retrieval snippet is available.';
    const source = makeSource({ snippet, documentBody: '' });

    const summary = buildEvidenceSummary([source]);

    expect(summary).toContain(snippet);
  });

  it('prefers a passed-in fullDocumentBodies entry over the narrowed source.documentBody', () => {
    const narrowedBody = 'Narrowed matched-chunk window only.';
    const wholeDocumentBody = 'The entire approved document body, much longer than the window. '.repeat(50);
    const source = makeSource({ snippet: 'preview', documentBody: narrowedBody });
    const fullDocumentBodies = new Map([['doc-1', { body: wholeDocumentBody }]]);

    const summary = buildEvidenceSummary([source], fullDocumentBodies);

    expect(summary).toContain(wholeDocumentBody.slice(0, 200));
    expect(summary).not.toContain(narrowedBody);
  });

  it('keeps as-retrieved (top-ranked-first) source order so truncation drops the weakest source', () => {
    const strong = makeSource({
      documentId: 'doc-strong',
      title: 'Strong Match',
      documentBody: 'Strong evidence. ',
    });
    const weak = makeSource({
      documentId: 'doc-weak',
      title: 'Weak Match',
      documentBody: 'Weak evidence. ',
    });

    const summary = buildEvidenceSummary([strong, weak]);
    expect(summary.indexOf('Strong Match')).toBeLessThan(summary.indexOf('Weak Match'));
  });

  it('returns a placeholder when there are no sources', () => {
    expect(buildEvidenceSummary([])).toBe('(no retrieved documents)');
  });
});
