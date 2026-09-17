// B0-1048 — detect "index"-shaped markdown sections (a product-name index/TOC/price-list table)
// so ingestion can keep them out of `rag.document_chunk` as retrievable prose, while still
// capturing the name -> description pairs for alias/entity resolution instead of discarding them.
//
// A pure product-name index table (name | one-line description | print page number) has no
// retrieval value as prose — the page-number column is dead weight, and a bare product-name match
// against it competes for top-K retrieval slots against chunks that actually answer the question.

import type { MarkdownChunk } from '~/lib/rag/markdown-chunking';

/**
 * Heading text that marks a section as a product-name index rather than retrievable prose.
 * Matched case-insensitively against the chunk's own `heading`.
 */
const INDEX_HEADING_RE =
  /\b(product\s+index|selection\s+guide|table\s+of\s+contents|quick\s+reference(?:\s+guide)?|price\s+list)\b/i;

export function isIndexHeading(heading: string | null): boolean {
  return Boolean(heading && INDEX_HEADING_RE.test(heading));
}

/**
 * Split a markdown table's lines into header / separator / body-row cell arrays. Returns null
 * when `text` isn't (or doesn't begin with) a markdown table.
 */
function parseTableRows(text: string): string[][] | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 3) return null; // header + separator + >=1 body row

  const toCells = (line: string) =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

  const header = toCells(lines[0]);
  const separator = toCells(lines[1]);
  const isSeparatorRow = separator.length > 0 && separator.every((c) => /^:?-{1,}:?$/.test(c));
  if (header.length === 0 || !isSeparatorRow) return null;

  const body = lines.slice(2).map(toCells);
  return [header, separator, ...body];
}

/**
 * Structural detection of a "name | description | page number" index table: exactly three
 * columns, a header whose last column is literally labeled as a page column (e.g. "Page", "Pg."),
 * and the last column is numeric for the large majority of body rows. Requiring the header label
 * (not just "3 columns + numeric last column") is deliberate: a label/SDS dilution or contact-time
 * table can just as easily be 3 columns with a numeric last column (e.g. "Product | Dilution |
 * Contact Time (sec)"), and that table must NOT be excluded from retrieval — see the "Regulated
 * data rule" in the org instructions.
 */
function looksLikeNameDescriptionPageTable(rows: string[][]): boolean {
  const [header, , ...body] = rows;
  if (body.length === 0) return false;
  if (!rows.every((r) => r.length === 3)) return false;

  const lastHeaderCell = (header[2] ?? '').toLowerCase();
  if (!/\bpage\b|\bpg\.?\b/.test(lastHeaderCell)) return false;

  const numericLastColumnCount = body.filter((r) => /^\d{1,4}$/.test((r[2] ?? '').trim())).length;
  return numericLastColumnCount / body.length >= 0.8;
}

export type IndexTableEntry = { name: string; description: string | null };

/**
 * Classify a chunk as an index/TOC-shaped section: either its heading names it as one
 * (`isIndexHeading`), or its text structurally looks like a 3-column name/description/page table.
 */
export function isIndexTableChunk(chunk: Pick<MarkdownChunk, 'heading' | 'text'>): boolean {
  if (isIndexHeading(chunk.heading)) return true;
  const rows = parseTableRows(chunk.text);
  return rows != null && looksLikeNameDescriptionPageTable(rows);
}

/**
 * Pull name -> description pairs out of an index-table chunk's body rows, dropping the
 * page-number column (no retrieval or alias value). Returns [] when the chunk's text isn't a
 * parseable table (e.g. a heading-matched section whose body is prose, not a table) — such a
 * section still contributes no alias candidates, which is a strict improvement over embedding it
 * as retrievable prose.
 */
export function extractIndexTableEntries(chunk: Pick<MarkdownChunk, 'text'>): IndexTableEntry[] {
  const rows = parseTableRows(chunk.text);
  if (!rows) return [];
  const [, , ...body] = rows;
  const entries: IndexTableEntry[] = [];
  for (const row of body) {
    const name = (row[0] ?? '').trim();
    const description = (row[1] ?? '').trim();
    if (!name) continue;
    entries.push({ name, description: description || null });
  }
  return entries;
}

/**
 * Split a full chunk list into the chunks that stay retrievable prose and the name/description
 * pairs mined from the ones that don't — so callers insert only `retrievable` into
 * `rag.document_chunk` and route `indexEntries` into alias/entity resolution instead of dropping
 * them.
 */
export function partitionIndexTableChunks<T extends Pick<MarkdownChunk, 'heading' | 'text'>>(
  chunks: T[],
): { retrievable: T[]; indexEntries: IndexTableEntry[] } {
  const retrievable: T[] = [];
  const indexEntries: IndexTableEntry[] = [];
  for (const chunk of chunks) {
    if (isIndexTableChunk(chunk)) {
      indexEntries.push(...extractIndexTableEntries(chunk));
    } else {
      retrievable.push(chunk);
    }
  }
  return { retrievable, indexEntries };
}
