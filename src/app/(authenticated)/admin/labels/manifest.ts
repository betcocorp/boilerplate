// Product label markdown ingest manifest.
// Source: s3://retool-360/labels/<brand>/<file>.md — the curated Betco,
// EnviroZyme, Basic Coatings, and 1950 Brands label corpus (see
// label-md/CONVERSION_MANIFEST.md and label-md/QA_REPORT.md for provenance).
//
// Unlike the "knowledge" ingest (brand-new source, hash-keyed), this corpus's
// rag.source_record / rag.entity rows already exist for a subset of products
// (Path B bootstrap — see label-md/_rag_import). The pipeline here keys off
// the SAME (source_schema='label_md', source_table=<brand>, source_pk=<file
// stem>) identity so it recognizes and extends those rows rather than
// creating duplicates under a different scheme.

export type LabelBrand = 'betco' | 'envirozyme' | 'basic_coatings' | '1950';

export type LabelSeedDocument = {
  /** file stem, e.g. "07512_kling" — matches rag.source_record.source_pk */
  id: string;
  title: string;
  brand: LabelBrand;
  sku: string | null;
  s3Key: string;
  /** "<brand-folder>/<file>.md", matches rag.entity.metadata->>label_md_path */
  labelMdPath: string;
};

export const LABEL_S3_BUCKET_DEFAULT = 'retool-360';
export const LABEL_S3_PREFIX_DEFAULT = 'labels/';

// Top-level S3 folder (under the prefix) -> normalized brand/source_table.
export const LABEL_FOLDER_BRAND: Record<string, LabelBrand> = {
  betco: 'betco',
  envirozyme: 'envirozyme',
  'basic-coatings': 'basic_coatings',
  '1950-brands': '1950',
};

/**
 * Optional per-file metadata overrides keyed by normalized relative path
 * (lowercase, forward slashes, rooted at LABEL_S3_PREFIX). Use when the
 * inferred title/brand/sku needs correcting.
 */
export const LABEL_FILE_OVERRIDES: Record<
  string,
  Partial<Pick<LabelSeedDocument, 'title' | 'brand' | 'sku'>>
> = {};
