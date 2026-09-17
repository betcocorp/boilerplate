import { describe, expect, it } from 'vitest';

import {
  chunkMarkdown,
  isMarkdownTableParagraph,
  splitMarkdownTableParagraph,
} from '~/lib/rag/markdown-chunking';

/** Builds a markdown table with `rowCount` data rows, each row long enough that a handful of
 * rows will exceed a small test char budget without needing a 4000-char fixture. */
function buildTable(rowCount: number, cellFiller = 'x'.repeat(30)) {
  const header = '| Product | Description | Page |';
  const separator = '| --- | --- | --- |';
  const rows = Array.from({ length: rowCount }, (_, i) => `| Product ${i} | ${cellFiller} | ${i + 1} |`);
  return [header, separator, ...rows].join('\n');
}

describe('isMarkdownTableParagraph (B0-1047)', () => {
  it('recognizes a header + separator pair', () => {
    expect(isMarkdownTableParagraph(buildTable(2))).toBe(true);
  });

  it('rejects plain prose', () => {
    expect(isMarkdownTableParagraph('Just a paragraph of prose.\nWith a second line.')).toBe(false);
  });

  it('rejects a single line containing a pipe but no separator row', () => {
    expect(isMarkdownTableParagraph('| Product | Description |')).toBe(false);
  });
});

describe('splitMarkdownTableParagraph (B0-1047)', () => {
  it('splits an oversized table into budget-respecting pieces, repeating header + separator', () => {
    const table = buildTable(20);
    const pieces = splitMarkdownTableParagraph(table, 200);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(200 + 'x'.repeat(30).length + 40); // allow one oversized row
      const lines = piece.split('\n');
      expect(lines[0]).toBe('| Product | Description | Page |');
      expect(lines[1]).toBe('| --- | --- | --- |');
      // every non-header/separator line must itself be a valid-looking table row
      for (const row of lines.slice(2)) {
        expect(row.trim().startsWith('|')).toBe(true);
      }
    }
  });

  it('keeps all data rows across the split pieces (no rows dropped or duplicated)', () => {
    const table = buildTable(15);
    const pieces = splitMarkdownTableParagraph(table, 150);
    const allRows = pieces.flatMap((p) => p.split('\n').slice(2));
    expect(allRows).toHaveLength(15);
    for (let i = 0; i < 15; i++) {
      expect(allRows.some((r) => r.includes(`Product ${i} `))).toBe(true);
    }
  });
});

describe('chunkMarkdown table handling (B0-1047)', () => {
  it('splits a markdown table exceeding the char budget into multiple chunks with the header repeated', () => {
    const body = ['# Product Index', '', buildTable(30)].join('\n');
    const chunks = chunkMarkdown(body, 300);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const lines = chunk.text.split('\n');
      expect(lines[0]).toBe('| Product | Description | Page |');
      expect(lines[1]).toBe('| --- | --- | --- |');
      expect(chunk.heading).toBe('Product Index');
    }
  });

  it('keeps a small table under budget as a single chunk', () => {
    const body = ['# Small Table', '', buildTable(3)].join('\n');
    const chunks = chunkMarkdown(body, 4000);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('| Product | Description | Page |');
    expect(chunks[0].text).toContain('Product 0');
    expect(chunks[0].text).toContain('Product 2');
  });

  it('still splits oversized prose sections by paragraph, unaffected by the table logic', () => {
    const paras = Array.from({ length: 5 }, (_, i) => `Paragraph number ${i}. `.repeat(10));
    const body = ['# Prose Section', '', paras.join('\n\n')].join('\n');
    const chunks = chunkMarkdown(body, 200);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.includes('|')).toBe(false);
      expect(chunk.heading).toBe('Prose Section');
    }
  });

  it('keeps small prose sections as a single chunk (no regression)', () => {
    const body = '# Overview\n\nThis is a short section that easily fits in one chunk.';
    const chunks = chunkMarkdown(body);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe('Overview');
    expect(chunks[0].text).toContain('This is a short section');
  });

  it('carries a heading with no body of its own forward into the next content-bearing section', () => {
    const body = '# Parent\n## Child\nActual content here.';
    const chunks = chunkMarkdown(body);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('Parent');
    expect(chunks[0].text).toContain('Actual content here.');
  });
});
