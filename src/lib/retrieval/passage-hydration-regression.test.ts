import { beforeEach, describe, expect, it, vi } from 'vitest';

import { inferSectionTypeFromQuery } from '~/lib/rag/section-type-inference';
import {
  assembleSelectedDocumentPassages,
  type DocumentPassageRequest,
} from '~/lib/retrieval/document-assembly';
import {
  passageSectionTypesForDocument,
  resolvePassageIntent,
} from '~/lib/retrieval/passage-intent';
import { buildModelToolPayload } from '~/lib/tools/model-tool-payload';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: vi.fn(),
}));

type PassageRow = {
  id: string;
  document_id: string;
  chunk_key: string;
  chunk_index: number;
  heading: string | null;
  chunk_text: string;
  section_path: string[];
  section_type: string;
  token_count: number;
};

function mockPassageRows(rows: PassageRow[]) {
  const builder: {
    in: () => typeof builder;
    order: () => typeof builder;
    then: (
      resolve: (value: { data: PassageRow[]; error: null }) => unknown,
    ) => unknown;
  } = {
    in: () => builder,
    order: () => builder,
    then: (resolve) => resolve({ data: rows, error: null }),
  };
  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue({
    schema: () => ({
      from: () => ({
        select: () => builder,
      }),
    }),
  } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>);
}

function labelRow(input: {
  id: string;
  documentId: string;
  chunkIndex: number;
  sectionType: string;
  text: string;
}): PassageRow {
  return {
    id: input.id,
    document_id: input.documentId,
    chunk_key: input.id,
    chunk_index: input.chunkIndex,
    heading: `${input.sectionType} <!-- section_type: ${input.sectionType} -->`,
    chunk_text: input.text,
    section_path: ['label', input.sectionType],
    section_type: 'label',
    token_count: 40,
  };
}

const CASES: Array<{
  caseId: string;
  query: string;
  documentId: string;
  documentKind: 'sds' | 'label';
  rows: PassageRow[];
  expectedChunkIds: string[];
  decisiveAssertions: string[];
}> = [
  {
    caseId: 'ROW-02',
    query: 'What is the pH of Push Mint?',
    documentId: 'a7841ada-ae39-4945-8e0d-a474d459284d',
    documentKind: 'sds',
    rows: [
      {
        id: '03210d60-2ae2-4639-8034-774dcf9b1877',
        document_id: 'a7841ada-ae39-4945-8e0d-a474d459284d',
        chunk_key: 'section-9-physical-properties',
        chunk_index: 13,
        heading: 'SECTION 9: Physical and chemical properties',
        chunk_text: '| pH | 6.5 to 8.5 |',
        section_path: ['sds', 'section_9'],
        section_type: 'physical_properties',
        token_count: 20,
      },
    ],
    expectedChunkIds: ['03210d60-2ae2-4639-8034-774dcf9b1877'],
    decisiveAssertions: ['pH', '6.5 to 8.5'],
  },
  {
    caseId: 'ROW-10',
    query:
      'What is the proper dilution ratio for Speedex Concentrate when cleaning heavy equipment with grease and oil?',
    documentId: '25cc0591-bd44-4f39-869a-40d9b7fe0060',
    documentKind: 'label',
    rows: [
      labelRow({
        id: '1c7b2507-5cff-442f-a5e2-4f8558ad0d9c',
        documentId: '25cc0591-bd44-4f39-869a-40d9b7fe0060',
        chunkIndex: 1,
        sectionType: 'directions',
        text: 'General cleaning: use 2 oz./gal or 16 mL/L (1:64).',
      }),
      labelRow({
        id: 'f9a3299d-27d6-4ffe-ab17-1da7fed8dc8c',
        documentId: '25cc0591-bd44-4f39-869a-40d9b7fe0060',
        chunkIndex: 2,
        sectionType: 'dilution',
        text: 'Heavy soil: 1:20, 6.4 oz./gal.',
      }),
    ],
    expectedChunkIds: [
      '1c7b2507-5cff-442f-a5e2-4f8558ad0d9c',
      'f9a3299d-27d6-4ffe-ab17-1da7fed8dc8c',
    ],
    decisiveAssertions: ['2 oz./gal', '16 mL/L', '1:64', '1:20', '6.4 oz./gal'],
  },
  {
    caseId: 'ROW-12',
    query: 'What dilution ratio does pH7Q use for general disinfection?',
    documentId: '46539a45-f6ae-49e5-a7a0-50638e18874f',
    documentKind: 'label',
    rows: [
      labelRow({
        id: 'fecf2271-eae3-41f1-95e3-2bbb32f5ecb0',
        documentId: '46539a45-f6ae-49e5-a7a0-50638e18874f',
        chunkIndex: 1,
        sectionType: 'directions',
        text: 'For general disinfection, allow the surface to remain wet for 10 minutes.',
      }),
      labelRow({
        id: '2988b0e7-7ced-4d3e-8060-3ba7f3fb2a51',
        documentId: '46539a45-f6ae-49e5-a7a0-50638e18874f',
        chunkIndex: 2,
        sectionType: 'dilution',
        text: 'DILUTION: 1:64 (660 ppm quat) 2 ounces per gallon of water.',
      }),
    ],
    expectedChunkIds: [
      'fecf2271-eae3-41f1-95e3-2bbb32f5ecb0',
      '2988b0e7-7ced-4d3e-8060-3ba7f3fb2a51',
    ],
    decisiveAssertions: ['10 minutes', '1:64', '2 ounces per gallon'],
  },
  {
    caseId: 'ROW-14',
    query: 'What PPE do I need when using Speedex Concentrate?',
    documentId: '25cc0591-bd44-4f39-869a-40d9b7fe0060',
    documentKind: 'label',
    rows: [
      labelRow({
        id: '1c7b2507-5cff-442f-a5e2-4f8558ad0d9c',
        documentId: '25cc0591-bd44-4f39-869a-40d9b7fe0060',
        chunkIndex: 1,
        sectionType: 'directions',
        text: 'Recommended: splash goggles. Wear protective chemical resistant gloves.',
      }),
      labelRow({
        id: '0fb22c6a-44e9-4120-bfcf-7e048797e648',
        documentId: '25cc0591-bd44-4f39-869a-40d9b7fe0060',
        chunkIndex: 4,
        sectionType: 'hazards',
        text: 'Signal word: DANGER. Corrosive. Wear protective gloves and eye or face protection.',
      }),
    ],
    expectedChunkIds: [
      '1c7b2507-5cff-442f-a5e2-4f8558ad0d9c',
      '0fb22c6a-44e9-4120-bfcf-7e048797e648',
    ],
    decisiveAssertions: [
      'splash goggles',
      'chemical resistant gloves',
      'DANGER',
      'Corrosive',
      'eye or face protection',
    ],
  },
  {
    caseId: 'ROW-25',
    query:
      'Can I use GE Fight Bac RTU to sanitize a soft surface such as upholstery, curtains, or a wrestling mat?',
    documentId: '3d46dbf6-76fe-41a1-8c62-5dfc09c7e298',
    documentKind: 'label',
    rows: [
      labelRow({
        id: 'dec7b859-6864-4dd8-b684-c792960335fe',
        documentId: '3d46dbf6-76fe-41a1-8c62-5dfc09c7e298',
        chunkIndex: 1,
        sectionType: 'surfaces',
        text: 'Soft surfaces include upholstered furniture, curtains, fabric, and textiles.',
      }),
      labelRow({
        id: '4aca0d50-ebee-4aef-9127-d850a2ff99d7',
        documentId: '3d46dbf6-76fe-41a1-8c62-5dfc09c7e298',
        chunkIndex: 2,
        sectionType: 'directions',
        text: 'Soft-surface sanitization: keep wet for 60 seconds. Effective against Klebsiella aerogenes and Staphylococcus aureus.',
      }),
    ],
    expectedChunkIds: [
      'dec7b859-6864-4dd8-b684-c792960335fe',
      '4aca0d50-ebee-4aef-9127-d850a2ff99d7',
    ],
    decisiveAssertions: [
      'Soft surfaces',
      '60 seconds',
      'Klebsiella aerogenes',
      'Staphylococcus aureus',
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(CASES)('$caseId passage readiness', (regression) => {
  it('hydrates the decisive same-document passage into model-visible context', async () => {
    mockPassageRows(regression.rows);
    const inferredSection = inferSectionTypeFromQuery(regression.query);
    const intent = resolvePassageIntent(regression.query, inferredSection);
    expect(intent).not.toBeNull();
    const sectionTypes = passageSectionTypesForDocument(
      intent!,
      regression.documentKind,
    );
    const request: DocumentPassageRequest = {
      documentId: regression.documentId,
      documentKind: regression.documentKind,
      sectionTypes,
    };

    const passages = await assembleSelectedDocumentPassages([request]);
    const passage = passages.get(regression.documentId);
    expect(passage?.body.documentId).toBe(regression.documentId);
    expect(passage?.body.chunkIds).toEqual(regression.expectedChunkIds);
    for (const assertion of regression.decisiveAssertions) {
      expect(passage?.body.body).toContain(assertion);
    }

    const modelPayload = buildModelToolPayload({
      sources: [
        {
          documentId: regression.documentId,
          chunkId: regression.expectedChunkIds[0],
          title: regression.caseId,
          documentBody: passage?.body.body,
          documentBodyChars: passage?.body.totalChars,
          documentBodyChunkCount: passage?.body.chunkCount,
          documentBodyTruncated: passage?.body.truncated,
          documentBodyTokenEstimate: passage?.body.estimatedTokens,
          documentBodyChunkIds: passage?.body.chunkIds,
          requestedSectionType: intent?.key,
          selectedSectionTypes: passage?.selectedSectionTypes,
          sectionOverrideApplied: true,
          sectionFallbackReason: null,
          confidence: 1,
          documentKind: regression.documentKind,
          productLineKey: null,
          productKey: null,
          s3Key: null,
          sourceUri: null,
          url: null,
        },
      ],
    });
    const modelSource = (modelPayload?.sources as Array<Record<string, unknown>>)[0];
    expect(modelSource?.documentBodyChunkIds).toEqual(regression.expectedChunkIds);
    for (const assertion of regression.decisiveAssertions) {
      expect(modelSource?.documentBody).toContain(assertion);
    }
  });
});
