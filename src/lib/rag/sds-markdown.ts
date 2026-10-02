import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { parse } from 'csv-parse/sync';

import { estimateTokens } from '~/lib/rag/markdown-chunking';

export const SDS_MARKDOWN_CHUNK_SIZE = 1600;
export const SDS_MARKDOWN_CHUNK_OVERLAP = 150;
export const SDS_MARKDOWN_CHUNKING_STRATEGY =
  'langchain-recursive-markdown-1600-150-section-v2';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MARKDOWN_HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const SDS_SECTION_RE = /^(?:section|secci[oó]n)\s+(\d{1,2})(?:\s*[.\-–—:]\s*|\s+)(.*)$/i;

export type SdsMarkdownManifestRow = {
  documentId: string;
  sourcePdfKey: string;
  markdownPath: string;
};

export type SdsMarkdownChunk = {
  chunkIndex: number;
  heading: string | null;
  sectionPath: string[];
  sectionType: string;
  chunkText: string;
  tokenCount: number;
};

type RawManifestRow = {
  document_id?: unknown;
  s3_key?: unknown;
  markdown_path?: unknown;
};

function requiredString(value: unknown, field: string, rowNumber: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`SDS markdown manifest row ${rowNumber} has an empty ${field}.`);
  }
  return value.trim();
}

function validateObjectKey(value: string, field: string, rowNumber: number): string {
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`SDS markdown manifest row ${rowNumber} has an unsafe ${field}.`);
  }
  return normalized;
}

export function parseSdsMarkdownManifest(csv: string): SdsMarkdownManifestRow[] {
  const records = parse(csv, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    trim: true,
  }) as RawManifestRow[];

  const documentIds = new Set<string>();
  const sourceKeys = new Set<string>();
  const markdownPaths = new Set<string>();

  return records.map((record, index) => {
    const rowNumber = index + 2;
    const documentId = requiredString(record.document_id, 'document_id', rowNumber);
    const sourcePdfKey = validateObjectKey(
      requiredString(record.s3_key, 's3_key', rowNumber),
      's3_key',
      rowNumber,
    );
    const markdownPath = validateObjectKey(
      requiredString(record.markdown_path, 'markdown_path', rowNumber),
      'markdown_path',
      rowNumber,
    );

    if (!UUID_RE.test(documentId)) {
      throw new Error(`SDS markdown manifest row ${rowNumber} has an invalid document_id.`);
    }
    if (!markdownPath.toLowerCase().endsWith('.md')) {
      throw new Error(`SDS markdown manifest row ${rowNumber} is not a markdown object.`);
    }
    if (documentIds.has(documentId) || sourceKeys.has(sourcePdfKey) || markdownPaths.has(markdownPath)) {
      throw new Error(`SDS markdown manifest row ${rowNumber} contains a duplicate identity.`);
    }

    documentIds.add(documentId);
    sourceKeys.add(sourcePdfKey);
    markdownPaths.add(markdownPath);
    return { documentId, sourcePdfKey, markdownPath };
  });
}

function headingBeforeLine(lines: string[], fromLine: number): string | null {
  for (let index = Math.min(fromLine - 1, lines.length - 1); index >= 0; index -= 1) {
    const match = lines[index]?.match(MARKDOWN_HEADING_RE);
    if (match) return match[2]!.trim();
  }
  return null;
}

function splitMarkdownBySdsSection(markdown: string): Array<{
  markdown: string;
  sectionHeading: string | null;
}> {
  const lines = markdown.split('\n');
  const segments: Array<{ markdown: string; sectionHeading: string | null }> = [];
  let start = 0;
  let sectionHeading: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index]?.match(MARKDOWN_HEADING_RE)?.[2]?.trim();
    if (!heading || !SDS_SECTION_RE.test(heading)) continue;
    if (index > start) {
      const segment = lines.slice(start, index).join('\n').trim();
      if (segment) segments.push({ markdown: segment, sectionHeading });
    }
    start = index;
    sectionHeading = heading;
  }

  const finalSegment = lines.slice(start).join('\n').trim();
  if (finalSegment) segments.push({ markdown: finalSegment, sectionHeading });
  return segments;
}

export function sdsSectionMetadata(heading: string | null): {
  sectionPath: string[];
  sectionType: string;
} {
  const match = heading?.match(SDS_SECTION_RE);
  if (!match) return { sectionPath: ['sds', 'preamble'], sectionType: 'sds' };

  const sectionNumber = Number.parseInt(match[1]!, 10);
  const sectionTypes: Record<number, string> = {
    2: 'hazard',
    3: 'composition',
    4: 'first_aid',
    5: 'fire_fighting',
    6: 'spill_response',
    7: 'handling_storage',
    8: 'exposure_ppe',
    9: 'physical_properties',
    10: 'stability',
    11: 'toxicology',
    12: 'ecological',
    13: 'disposal',
    14: 'transport',
    15: 'regulatory',
    16: 'other_info',
  };

  return {
    sectionPath: ['sds', `section_${sectionNumber}`],
    sectionType: sectionTypes[sectionNumber] ?? 'sds',
  };
}

export async function chunkSdsMarkdown(markdown: string): Promise<SdsMarkdownChunk[]> {
  if (!markdown.trim()) return [];

  const splitter = RecursiveCharacterTextSplitter.fromLanguage('markdown', {
    chunkSize: SDS_MARKDOWN_CHUNK_SIZE,
    chunkOverlap: SDS_MARKDOWN_CHUNK_OVERLAP,
    keepSeparator: true,
  });
  const chunks: SdsMarkdownChunk[] = [];
  for (const segment of splitMarkdownBySdsSection(markdown)) {
    const documents = await splitter.createDocuments([segment.markdown]);
    const segmentLines = segment.markdown.split('\n');
    const { sectionPath, sectionType } = sdsSectionMetadata(segment.sectionHeading);
    for (const document of documents) {
      const chunkText = document.pageContent.trim();
      if (!chunkText) continue;
      const fromLine = document.metadata?.loc?.lines?.from;
      const headingInChunk = document.pageContent
        .split('\n')
        .map((line) => line.match(MARKDOWN_HEADING_RE)?.[2]?.trim() ?? null)
        .filter((value): value is string => value !== null)
        .at(-1);
      const heading =
        headingInChunk ??
        (typeof fromLine === 'number'
          ? headingBeforeLine(segmentLines, fromLine)
          : segment.sectionHeading);
      chunks.push({
        chunkIndex: chunks.length,
        heading,
        sectionPath,
        sectionType,
        chunkText,
        tokenCount: estimateTokens(chunkText),
      });
    }
  }
  return chunks;
}
