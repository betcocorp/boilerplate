import { describe, expect, it } from 'vitest';

import {
  asRagDocumentKind,
  documentKindLabel,
  RAG_DOCUMENT_KINDS,
} from '~/lib/rag/document-kind';

describe('rag document kinds (B0-293)', () => {
  it('covers exactly the live rag.document.document_kind values plus the synthetic facts kind', () => {
    // Verified against the database on 2026-08-26: sds, product_line_profile, label, efficacy,
    // knowledge. `facts` is the synthetic "Verified Product Facts" source product-tools.ts emits.
    expect([...RAG_DOCUMENT_KINDS].sort()).toEqual([
      'efficacy',
      'facts',
      'knowledge',
      'label',
      'product_line_profile',
      'sds',
    ]);
  });

  it('labels every known kind', () => {
    for (const kind of RAG_DOCUMENT_KINDS) {
      expect(documentKindLabel(kind)).toBeTruthy();
    }
    expect(documentKindLabel('sds')).toBe('SDS');
    expect(documentKindLabel('product_line_profile')).toBe('Product');
    expect(documentKindLabel('facts')).toBe('Verified facts');
  });

  it('renders no label for an absent kind — a historical source must not gain a badge', () => {
    expect(documentKindLabel(undefined)).toBeNull();
    expect(documentKindLabel(null)).toBeNull();
    expect(documentKindLabel('')).toBeNull();
  });

  it('renders no label for a kind we cannot vouch for, rather than guessing', () => {
    expect(documentKindLabel('brochure')).toBeNull();
    expect(asRagDocumentKind('brochure')).toBeNull();
    expect(asRagDocumentKind(42)).toBeNull();
    expect(asRagDocumentKind('label')).toBe('label');
  });
});
