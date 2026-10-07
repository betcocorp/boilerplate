// B0-188 — v1 markdown knowledge ingest manifest.
// Source: s3://retool-360/v1-markdown-files/<specialist>/<file>.md (see the consolidated upload).

// B0-746 — the former single `floor` specialist was split into four substrate specialists.
// `sportszone`/`vct` are real ingest folders and now map to their own specific ids;
// `floor_concrete` and `floor_stg` have NO dedicated ingest folder yet (flagged in
// `KNOWLEDGE_FOLDER_SPECIALIST` below) — a future ingest ticket is expected to add them.
export type KnowledgeSpecialist =
  | 'bathroom'
  | 'floor_wood_sport'
  | 'floor_concrete'
  | 'floor_stg'
  | 'floor_vct'
  | 'product'
  | 'general';
export type KnowledgeDocType =
  | 'troubleshooting'
  | 'faq'
  | 'howto'
  | 'glossary'
  | 'workbook'
  | 'general';

export type KnowledgeSeedDocument = {
  id: string;
  title: string;
  specialist: KnowledgeSpecialist;
  docType: KnowledgeDocType;
  productLineKey: string | null;
  s3Key: string;
};

export const KNOWLEDGE_S3_BUCKET_DEFAULT = 'retool-360';
export const KNOWLEDGE_S3_PREFIX_DEFAULT = 'v1-markdown-files/';

// Top-level folder (under the prefix) → SME specialist. Folders come from the
// consolidated upload: restroom/ sportszone/ vct/.
export const KNOWLEDGE_FOLDER_SPECIALIST: Record<string, KnowledgeSpecialist> = {
  restroom: 'bathroom',
  sportszone: 'floor_wood_sport',
  vct: 'floor_vct',
  product: 'product',
  // B0-746 gap: no `concrete` or `stg` ingest folder exists yet — `floor_concrete` and `floor_stg`
  // retrieve from the same general product/label documents as any other specialist until a future
  // ingest ticket adds dedicated folders for them. Not fabricated here.
};

/**
 * Optional per-file metadata overrides keyed by normalized relative path
 * (lowercase, forward slashes, rooted at KNOWLEDGE_S3_PREFIX). Use when the
 * inferred title/specialist/doc_type/product line needs correcting.
 */
export const KNOWLEDGE_FILE_OVERRIDES: Record<
  string,
  Partial<Pick<KnowledgeSeedDocument, 'title' | 'specialist' | 'docType' | 'productLineKey'>>
> = {};
