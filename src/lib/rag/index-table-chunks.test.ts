import { describe, expect, it } from 'vitest';

import {
  extractIndexTableEntries,
  isIndexHeading,
  isIndexTableChunk,
  partitionIndexTableChunks,
} from '~/lib/rag/index-table-chunks';

const INDEX_TABLE_TEXT = [
  '| Product | Description | Page |',
  '| --- | --- | --- |',
  '| Kling | Toilet bowl cleaner | 12 |',
  '| Symplicity | Neutral disinfectant cleaner | 13 |',
  '| Green Earth | All purpose cleaner | 14 |',
].join('\n');

const DILUTION_TABLE_TEXT = [
  '| Product | Dilution | Contact Time (sec) |',
  '| --- | --- | --- |',
  '| Kling | 1:64 | 600 |',
  '| Symplicity | 1:128 | 300 |',
].join('\n');

describe('isIndexHeading (B0-1048)', () => {
  it('matches known index/TOC heading phrasing', () => {
    expect(isIndexHeading('Product Index')).toBe(true);
    expect(isIndexHeading('Selection Guide')).toBe(true);
    expect(isIndexHeading('Table of Contents')).toBe(true);
    expect(isIndexHeading('Quick Reference')).toBe(true);
  });

  it('does not match unrelated or null headings', () => {
    expect(isIndexHeading('Directions For Use')).toBe(false);
    expect(isIndexHeading('Dilution Chart')).toBe(false);
    expect(isIndexHeading(null)).toBe(false);
  });
});

describe('isIndexTableChunk (B0-1048)', () => {
  it('classifies a name/description/page table as an index chunk via structural detection', () => {
    expect(isIndexTableChunk({ heading: null, text: INDEX_TABLE_TEXT })).toBe(true);
  });

  it('classifies a section under an index-style heading even without a table', () => {
    expect(isIndexTableChunk({ heading: 'Product Index', text: 'See the catalog insert.' })).toBe(true);
  });

  it('does NOT classify a regulated dilution/contact-time table as an index table', () => {
    // Same "3 columns, numeric last column" shape as an index table, but the header names a
    // regulated value (contact time), not a page number — must never be excluded from retrieval.
    expect(isIndexTableChunk({ heading: null, text: DILUTION_TABLE_TEXT })).toBe(false);
  });

  it('does not classify ordinary prose as an index table', () => {
    expect(isIndexTableChunk({ heading: 'Overview', text: 'This product is a floor cleaner.' })).toBe(
      false,
    );
  });
});

describe('extractIndexTableEntries (B0-1048)', () => {
  it('pulls name/description pairs and drops the page-number column', () => {
    const entries = extractIndexTableEntries({ text: INDEX_TABLE_TEXT });
    expect(entries).toEqual([
      { name: 'Kling', description: 'Toilet bowl cleaner' },
      { name: 'Symplicity', description: 'Neutral disinfectant cleaner' },
      { name: 'Green Earth', description: 'All purpose cleaner' },
    ]);
  });

  it('returns [] for a heading-matched section with no parseable table', () => {
    expect(extractIndexTableEntries({ text: 'See the catalog insert.' })).toEqual([]);
  });
});

describe('partitionIndexTableChunks (B0-1048)', () => {
  it('routes index-table chunks out of retrievable and mines their entries', () => {
    const chunks = [
      { heading: 'Product Index', text: INDEX_TABLE_TEXT, index: 0, sectionPath: ['Product Index'] },
      { heading: 'Dilution', text: DILUTION_TABLE_TEXT, index: 1, sectionPath: ['Dilution'] },
      { heading: 'Overview', text: 'This product is a floor cleaner.', index: 2, sectionPath: ['Overview'] },
    ];

    const { retrievable, indexEntries } = partitionIndexTableChunks(chunks);

    expect(retrievable).toHaveLength(2);
    expect(retrievable.map((c) => c.heading)).toEqual(['Dilution', 'Overview']);
    expect(indexEntries).toHaveLength(3);
    expect(indexEntries[0]).toEqual({ name: 'Kling', description: 'Toilet bowl cleaner' });
  });

  it('keeps everything retrievable when nothing looks like an index table', () => {
    const chunks = [
      { heading: 'Overview', text: 'Prose only.', index: 0, sectionPath: ['Overview'] },
      { heading: 'Dilution', text: DILUTION_TABLE_TEXT, index: 1, sectionPath: ['Dilution'] },
    ];
    const { retrievable, indexEntries } = partitionIndexTableChunks(chunks);
    expect(retrievable).toHaveLength(2);
    expect(indexEntries).toEqual([]);
  });
});
