import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  chunkSdsMarkdown,
  parseSdsMarkdownManifest,
  SDS_MARKDOWN_CHUNK_OVERLAP,
  SDS_MARKDOWN_CHUNK_SIZE,
  sdsSectionMetadata,
} from './sds-markdown';

const MANIFEST = `document_id,s3_key,markdown_path
909e0ecb-f7b2-463f-a6b8-127be26d688c,Betco SDS/2610.pdf,markdown/909e0ecb-f7b2-463f-a6b8-127be26d688c.md
04aa6aba-8dd2-4553-a7e2-8be66dfff419,Betco SDS/2900.pdf,markdown/04aa6aba-8dd2-4553-a7e2-8be66dfff419.md
`;

describe('parseSdsMarkdownManifest', () => {
  it('maps existing document UUIDs to source PDFs and markdown objects', () => {
    expect(parseSdsMarkdownManifest(MANIFEST)).toEqual([
      {
        documentId: '909e0ecb-f7b2-463f-a6b8-127be26d688c',
        sourcePdfKey: 'Betco SDS/2610.pdf',
        markdownPath: 'markdown/909e0ecb-f7b2-463f-a6b8-127be26d688c.md',
      },
      {
        documentId: '04aa6aba-8dd2-4553-a7e2-8be66dfff419',
        sourcePdfKey: 'Betco SDS/2900.pdf',
        markdownPath: 'markdown/04aa6aba-8dd2-4553-a7e2-8be66dfff419.md',
      },
    ]);
  });

  it('accepts the converter canary manifest without adaptation', () => {
    const generatedContractFixture = readFileSync(
      resolve(process.cwd(), 'scripts/docling/fixtures/sds-ingestion-canary-manifest.csv'),
      'utf8',
    );

    expect(parseSdsMarkdownManifest(generatedContractFixture)).toEqual([
      {
        documentId: 'b0e2d441-a7cb-4bee-9c6e-01aee328edb8',
        sourcePdfKey: 'Finished Good SDS/Push (Mint)_M000133.pdf',
        markdownPath: 'markdown/push-mint.md',
      },
      {
        documentId: 'c80c9697-568d-4a49-b85b-2b7b720b3392',
        sourcePdfKey:
          'Basic SDS/Chemtrec SDS files ready to transfer/1664 – StreetShoe NXT Gloss SDS English.pdf',
        markdownPath: 'markdown/streets-shoe-nxt-gloss.md',
      },
    ]);
  });

  it('rejects duplicate identities and unsafe object keys', () => {
    expect(() => parseSdsMarkdownManifest(`${MANIFEST.trim()}\n${MANIFEST.split('\n')[1]}\n`)).toThrow(
      'duplicate identity',
    );
    expect(() =>
      parseSdsMarkdownManifest(
        'document_id,s3_key,markdown_path\n909e0ecb-f7b2-463f-a6b8-127be26d688c,Betco SDS/2610.pdf,../secret.md',
      ),
    ).toThrow('unsafe markdown_path');
  });

  it('rejects malformed document IDs and non-markdown objects', () => {
    expect(() =>
      parseSdsMarkdownManifest(
        'document_id,s3_key,markdown_path\nnot-a-uuid,Betco SDS/2610.pdf,markdown/file.md',
      ),
    ).toThrow('invalid document_id');
    expect(() =>
      parseSdsMarkdownManifest(
        'document_id,s3_key,markdown_path\n909e0ecb-f7b2-463f-a6b8-127be26d688c,Betco SDS/2610.pdf,markdown/file.txt',
      ),
    ).toThrow('not a markdown object');
  });
});

describe('chunkSdsMarkdown', () => {
  it('uses recursive markdown splitting with the configured size and overlap', async () => {
    const paragraph = 'Wear protective gloves and eye protection. '.repeat(90);
    const chunks = await chunkSdsMarkdown(`# Product\n\n## Section 8: Exposure controls\n\n${paragraph}`);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.chunkText.length <= SDS_MARKDOWN_CHUNK_SIZE)).toBe(true);
    expect(SDS_MARKDOWN_CHUNK_OVERLAP).toBe(150);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(
      Array.from({ length: chunks.length }, (_, index) => index),
    );
    expect(chunks.every((chunk) => chunk.tokenCount > 0)).toBe(true);
  });

  it('carries the nearest markdown heading into SDS section metadata', async () => {
    const chunks = await chunkSdsMarkdown(
      '# Product name\n\n## Section 4: First aid measures\n\nCall a poison control center for advice.',
    );
    const firstAid = chunks.find((chunk) => chunk.chunkText.includes('poison control'));

    expect(firstAid).toMatchObject({
      heading: 'Section 4: First aid measures',
      sectionPath: ['sds', 'section_4'],
      sectionType: 'first_aid',
    });
  });

  it('keeps parent SDS section metadata after nested markdown headings', async () => {
    const physicalProperties = 'Physical property detail. '.repeat(140);
    const chunks = await chunkSdsMarkdown(
      `# Product name\n\n## Section 9: Physical and chemical properties\n\n## Appearance\n\n${physicalProperties}`,
    );
    const appearanceChunks = chunks.filter((chunk) =>
      chunk.chunkText.includes('Physical property detail.'),
    );

    expect(appearanceChunks.length).toBeGreaterThan(1);
    expect(appearanceChunks.every((chunk) => chunk.heading === 'Appearance')).toBe(true);
    expect(
      appearanceChunks.every(
        (chunk) =>
          chunk.sectionType === 'physical_properties' &&
          chunk.sectionPath.join('/') === 'sds/section_9',
      ),
    ).toBe(true);
  });

  it('does not merge adjacent SDS sections into one metadata scope', async () => {
    const chunks = await chunkSdsMarkdown(
      '## Section 9: Physical properties\n\npH: 7\n\n' +
        '## Section 10: Stability and reactivity\n\nStable under normal conditions.',
    );

    expect(chunks.map(({ sectionType, sectionPath }) => ({ sectionType, sectionPath }))).toEqual([
      { sectionType: 'physical_properties', sectionPath: ['sds', 'section_9'] },
      { sectionType: 'stability', sectionPath: ['sds', 'section_10'] },
    ]);
  });

  it('returns no chunks for empty markdown', async () => {
    await expect(chunkSdsMarkdown('  \n')).resolves.toEqual([]);
  });
});

describe('sdsSectionMetadata', () => {
  it('maps English and Spanish GHS headings', () => {
    expect(sdsSectionMetadata('SECTION 7 - HANDLING AND STORAGE')).toEqual({
      sectionPath: ['sds', 'section_7'],
      sectionType: 'handling_storage',
    });
    expect(sdsSectionMetadata('Sección 2. Identificación de peligros')).toEqual({
      sectionPath: ['sds', 'section_2'],
      sectionType: 'hazard',
    });
  });
});
