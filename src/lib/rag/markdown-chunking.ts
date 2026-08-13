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
