/**
 * Heading-aware markdown chunker for knowledge ingest (design §5, option 2).
 *
 * The v1 files are cleanly structured with `#`/`##`/`###` headings — the natural chunk boundary.
 * Each chunk carries its heading + full ancestor path (populates `document_chunk.heading` /
 * `section_path`, which feed the tsvector + corpus match), and the breadcrumb is prepended to the
 * chunk text so an embedded chunk is self-descriptive. Sections longer than `maxChars` are split on
 * paragraph boundaries. Pure — the pipeline writes the rows and reuses the existing embedding path.
 */

export type MarkdownChunk = {
  index: number;
  heading: string | null;
  sectionPath: string[];
  text: string;
};

const DEFAULT_MAX_CHARS = 2000;

/** Split an over-long section on blank-line paragraph boundaries, hard-splitting any giant paragraph. */
function splitByChar(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  let current = '';
  for (const para of text.split(/\n{2,}/)) {
    if (current && current.length + para.length + 2 > maxChars) {
      out.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${para}` : para;
    while (current.length > maxChars) {
      out.push(current.slice(0, maxChars));
      current = current.slice(maxChars);
    }
  }
  if (current.trim()) out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function chunkMarkdownByHeadings(
  markdown: string,
  opts: { maxChars?: number } = {},
): MarkdownChunk[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const lines = markdown.split(/\r?\n/);
  const stack: Array<{ level: number; title: string }> = [];
  const chunks: MarkdownChunk[] = [];
  let buffer: string[] = [];
  let index = 0;

  const flush = () => {
    const body = buffer.join('\n').trim();
    buffer = [];
    if (!body) return;
    const sectionPath = stack.map((s) => s.title);
    const heading = stack.length > 0 ? stack[stack.length - 1]!.title : null;
    const breadcrumb = sectionPath.join(' > ');
    for (const piece of splitByChar(body, maxChars)) {
      chunks.push({
        index: index++,
        heading,
        sectionPath,
        text: breadcrumb ? `${breadcrumb}\n\n${piece}` : piece,
      });
    }
  };

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      const level = match[1].length;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title: match[2].trim() });
    } else {
      buffer.push(line);
    }
  }
  flush();
  return chunks;
}
