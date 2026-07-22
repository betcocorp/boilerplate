export type EfficacySeedDocument = {
  id: string;
  title: string;
  s3Key: string;
  locale: string;
};

export const EFFICACY_S3_BUCKET_DEFAULT = 'betco-efficacy';
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
