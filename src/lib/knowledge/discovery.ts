import { KNOWLEDGE_S3_PREFIX } from '~/lib/knowledge/storage';

/**
 * Pure metadata derivation for the v1 markdown knowledge files (document_kind='knowledge').
 * Grounded in the real `s3://retool-360/v1-markdown-files/` layout: top folders `restroom` /
 * `sportszone` / `vct`, clean markdown (no YAML frontmatter observed), first `# Heading` = title.
 * The specialist mapping matches the SME agent ids (bathroom / floor / product).
 */

export type KnowledgeSpecialist = 'bathroom' | 'floor' | 'product' | null;
export type KnowledgeDocType =
  | 'troubleshooting'
  | 'faq'
  | 'howto'
  | 'glossary'
  | 'workbook'
  | 'reference';

const SPECIALIST_BY_FOLDER: Record<string, Exclude<KnowledgeSpecialist, null>> = {
  restroom: 'bathroom',
  bathroom: 'bathroom',
  sportszone: 'floor',
  vct: 'floor',
  floor: 'floor',
  product: 'product',
};

/** Specialist from the top folder of the key (relative to the knowledge prefix). */
export function specialistFromKey(key: string, prefix: string = KNOWLEDGE_S3_PREFIX): KnowledgeSpecialist {
  const rel = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  const folder = rel.split('/')[0]?.toLowerCase() ?? '';
  return SPECIALIST_BY_FOLDER[folder] ?? null;
}

/** Doc-type heuristic from the file name (drives retrieval bias + display). */
export function docTypeFromKey(fileName: string): KnowledgeDocType {
  const n = fileName.toLowerCase();
  if (n.includes('troubleshoot')) return 'troubleshooting';
  if (n.includes('faq')) return 'faq';
  if (n.includes('glossary')) return 'glossary';
  if (n.includes('workbook') || n.endsWith('_full.md')) return 'workbook';
  if (n.includes('how') || n.includes('guide') || n.includes('process') || n.includes('procedure')) {
    return 'howto';
  }
  return 'reference';
}

/** Title-case a file name into a readable fallback title. */
export function inferTitle(fileName: string): string {
  return fileName
    .replace(/\.md$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Split optional YAML-ish frontmatter (defensive — the v1 files don't use it) from the body. */
export function stripFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      frontmatter[line.slice(0, idx).trim()] = line
        .slice(idx + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  }
  return { frontmatter, body: raw.slice(match[0].length) };
}

/** The first `# ` (H1) heading text, if any. */
export function firstHeadingTitle(body: string): string | null {
  const match = /^#\s+(.+)$/m.exec(body);
  return match ? match[1].trim() : null;
}

/** Strip markdown syntax to plain text for `body_text` (tsvector / non-markdown consumers). */
export function markdownToText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_>#]+/g, ' ')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type KnowledgeDocMeta = {
  s3Key: string;
  title: string;
  specialist: KnowledgeSpecialist;
  docType: KnowledgeDocType;
  bodyMarkdown: string;
  bodyText: string;
};

/** Derive the full ingest metadata + body split for one markdown object. */
export function deriveKnowledgeDoc(input: { key: string; raw: string; prefix?: string }): KnowledgeDocMeta {
  const prefix = input.prefix ?? KNOWLEDGE_S3_PREFIX;
  const fileName = input.key.split('/').pop() ?? input.key;
  const { frontmatter, body } = stripFrontmatter(input.raw);
  const title = frontmatter.title || firstHeadingTitle(body) || inferTitle(fileName);
  return {
    s3Key: input.key,
    title,
    specialist: specialistFromKey(input.key, prefix),
    docType: docTypeFromKey(fileName),
    bodyMarkdown: body,
    bodyText: markdownToText(body),
  };
}
