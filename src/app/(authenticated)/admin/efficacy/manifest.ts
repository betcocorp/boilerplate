export type EfficacySeedDocument = {
  id: string;
  title: string;
  s3Key: string;
  locale: string;
};

// Efficacy source files live in the same shared bucket as Knowledge/Labels
// (retool-360), under the 'efficacy/' prefix below — not a separate bucket.
export const EFFICACY_S3_BUCKET_DEFAULT = 'retool-360';
export const EFFICACY_S3_PREFIX_DEFAULT = 'efficacy/';

/**
 * Optional per-file metadata overrides keyed by normalized relative path
 * (lowercase, forward slashes, rooted at EFFICACY_S3_PREFIX_DEFAULT or
 * EFFICACY_S3_PREFIX). Empty until real efficacy source files land.
 */
export const EFFICACY_FILE_OVERRIDES: Record<
  string,
  Partial<Pick<EfficacySeedDocument, 'title' | 'locale'>>
> = {};
