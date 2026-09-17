// Shared heading-aware markdown chunker used by the "knowledge" and "labels"
// admin ingest panels (admin/knowledge, admin/labels). Splits on markdown
// headings (# .. ######), keeps a breadcrumb section_path, and further splits
// oversized sections by paragraph.
//
// B0-279: Token-aware chunking with proper OpenAI tokenizer.
// Chunks are split to fit within ~1200 token budget (chars capped at 4800 for
// initial split, then exact token counting in the RPC ingestion pipeline).
// Tiny chunks (<40 tokens) are carried forward and merged into the next
// content-bearing section to avoid orphaned chunks that embed on headings alone.

import { SAFE_CHUNK_CHAR_BUDGET } from '~/lib/rag/token-counter';

// Keep the old constant for backward compatibility, but use the new one
export const MARKDOWN_CHUNK_CHAR_BUDGET = SAFE_CHUNK_CHAR_BUDGET; // ~1200 tokens

export type MarkdownChunk = {
  index: number;
  heading: string | null;
  sectionPath: string[];
  text: string;
};

export function chunkMarkdown(
  body: string,
  charBudget: number = MARKDOWN_CHUNK_CHAR_BUDGET,
): MarkdownChunk[] {
  const lines = body.split('\n');
  const sections: Array<{ heading: string | null; path: string[]; lines: string[] }> = [];
  const headingStack: Array<{ level: number; text: string }> = [];
  let current: { heading: string | null; path: string[]; lines: string[] } = {
    heading: null,
    path: [],
    lines: [],
  };

  const pushCurrent = () => {
    if (current.lines.join('').trim().length > 0 || current.heading) sections.push(current);
  };

  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      pushCurrent();
      const level = h[1].length;
      const text = h[2].trim();
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level)
        headingStack.pop();
      headingStack.push({ level, text });
      current = { heading: text, path: headingStack.map((x) => x.text), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  pushCurrent();

  const chunks: MarkdownChunk[] = [];
  let index = 0;
  // A heading with no body of its own (e.g. a section header immediately followed
  // by a sub-heading) must never become a content-less chunk — that would embed on
  // the heading alone and rank for a query while returning nothing. Carry such bare
  // headings forward and fold them into the next content-bearing section; drop any
  // left dangling at EOF.
  let carriedHeadings: string[] = [];
  for (const section of sections) {
    const sectionBody = section.lines.join('\n').trim();
    if (!sectionBody) {
      if (section.heading) carriedHeadings.push(section.heading);
      continue;
    }

    const foldPrefix = carriedHeadings.length ? `${carriedHeadings.join('\n')}\n` : '';
    const heading = section.heading ?? carriedHeadings[carriedHeadings.length - 1] ?? null;
    carriedHeadings = [];
    const text = `${foldPrefix}${sectionBody}`;

    if (text.length <= charBudget) {
      chunks.push({ index: index++, heading, sectionPath: section.path, text });
      continue;
    }
    // Oversized section: split by blank-line paragraphs into <= budget windows.
    const paras = text.split(/\n{2,}/);
    let buf = '';
    for (const para of paras) {
      // B0-1047: a markdown table has no blank lines between rows, so it survives the
      // paragraph split above as a single "paragraph" no matter how many rows it has. The
      // generic size guard below only ever fires *between* paragraphs (buf starts empty), so
      // an oversized table was previously emitted whole. Detect that shape here and split it
      // by row-groups instead, repeating the header/separator row on every split-off piece so
      // each chunk stays a syntactically valid, self-contained table.
      if (para.length > charBudget && isMarkdownTableParagraph(para)) {
        if (buf.trim()) {
          chunks.push({ index: index++, heading, sectionPath: section.path, text: buf.trim() });
          buf = '';
        }
        for (const tablePiece of splitMarkdownTableParagraph(para, charBudget)) {
          chunks.push({ index: index++, heading, sectionPath: section.path, text: tablePiece });
        }
        continue;
      }
      if (buf && buf.length + para.length + 2 > charBudget) {
        chunks.push({ index: index++, heading, sectionPath: section.path, text: buf.trim() });
        buf = '';
      }
      buf = buf ? `${buf}\n\n${para}` : para;
    }
    if (buf.trim()) {
      chunks.push({ index: index++, heading, sectionPath: section.path, text: buf.trim() });
    }
  }
  return chunks;
}

/** A GFM table separator cell: optional leading/trailing `:` (alignment) around one or more `-`. */
const TABLE_SEPARATOR_CELL_RE = /^:?-{1,}:?$/;

function isTableSeparatorRow(line: string): boolean {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (!trimmed) return false;
  const cells = trimmed.split('|').map((c) => c.trim());
  return cells.length > 0 && cells.every((c) => TABLE_SEPARATOR_CELL_RE.test(c));
}

/**
 * B0-1047: true when `text` is (or begins with) a markdown table — a `|...|` header row
 * immediately followed by a `|---|---|`-style separator row. Only the first two non-blank
 * lines are inspected, matching how `chunkMarkdown` already isolates paragraphs on blank lines.
 */
export function isMarkdownTableParagraph(text: string): boolean {
  const lines = text.split('\n');
  const nonBlank = lines.filter((l) => l.trim().length > 0);
  if (nonBlank.length < 2) return false;
  const [headerLine, separatorLine] = nonBlank;
  return headerLine.includes('|') && isTableSeparatorRow(separatorLine);
}

/**
 * B0-1047: split an oversized markdown table into <= `budget`-char chunks by row-groups,
 * repeating the header row and separator row at the top of every split-off chunk so each piece
 * stays a syntactically valid, self-contained table. Never splits *within* a row — a single row
 * (e.g. a very wide table row) is emitted whole even if it alone exceeds budget, since splitting
 * mid-cell could truncate a dilution ratio, EPA registration number, or other regulated value.
 */
export function splitMarkdownTableParagraph(text: string, budget: number): string[] {
  const lines = text.split('\n');
  const nonBlankIdx = lines.findIndex((l) => l.trim().length > 0);
  if (nonBlankIdx === -1) return [text];

  // Locate header + separator among the first two non-blank lines, preserving original spacing.
  let headerLine: string | null = null;
  let separatorLine: string | null = null;
  let bodyStart = -1;
  for (let i = nonBlankIdx; i < lines.length; i++) {
    if (lines[i].trim().length === 0) continue;
    if (headerLine === null) {
      headerLine = lines[i];
      continue;
    }
    if (separatorLine === null) {
      separatorLine = lines[i];
      bodyStart = i + 1;
      break;
    }
  }
  if (headerLine === null || separatorLine === null) return [text];

  const prefix = `${headerLine}\n${separatorLine}`;
  const bodyRows = lines.slice(bodyStart).filter((l) => l.trim().length > 0);

  const pieces: string[] = [];
  let buf = '';
  for (const row of bodyRows) {
    const candidate = buf ? `${buf}\n${row}` : row;
    if (buf && `${prefix}\n${candidate}`.length > budget) {
      pieces.push(`${prefix}\n${buf}`);
      buf = row;
    } else {
      buf = candidate;
    }
  }
  if (buf) {
    pieces.push(`${prefix}\n${buf}`);
  }
  return pieces.length > 0 ? pieces : [text];
}

export function markdownToPlainText(md: string) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~-]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function summarize(text: string, maxLength = 280) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3).trim()}...`;
}

export function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}
