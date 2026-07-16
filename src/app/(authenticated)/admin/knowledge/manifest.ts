// B0-188 — v1 markdown knowledge ingest manifest.
// Source: s3://retool-360/v1-markdown-files/<specialist>/<file>.md (see the consolidated upload).

export type KnowledgeSpecialist = 'bathroom' | 'floor' | 'product' | 'general';
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
  sportszone: 'floor',
  vct: 'floor',
  product: 'product',
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
