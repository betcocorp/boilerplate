/**
 * B0-256/B0-258: Label ingestion utilities
 *
 * Helper functions for Betco brand classification, product status determination,
 * and photo URL extraction from legacy product data.
 *
 * Note: Direct label table ingestion is deferred until rag.label and rag.label_chunk
 * migrations are applied and types are regenerated. These utilities provide the
 * core logic for brand/status/photo handling that can be used by admin UI endpoints
 * or background jobs.
 */

export type LabelBrand = 'betco' | 'envirozyme' | 'basic_coatings' | '1950';

export interface LegacyProductFields {
  ProductsKey?: string | null;
  Title?: string | null;
  SKU?: string | null;
  DSLProdLn?: string | null;
  Status?: string | null;
  OnWeb?: number | null;
  User_Str_00?: string | null; // Photo URL field
}

/**
 * Classify a product into a brand category based on DSLProdLn field.
 *
 * Matches against keywords: 1950, Basic Coatings, EnviroZyme
 * Default: 'betco' if no match found or DSLProdLn is null.
 */
export function classifyProductBrand(dslProdLn: string | null | undefined): LabelBrand {
  if (!dslProdLn) return 'betco';

  const lower = dslProdLn.toLowerCase();
  if (lower.includes('1950')) return '1950';
  if (lower.includes('basic') || lower.includes('basiccoatings')) return 'basic_coatings';
  if (lower.includes('envirozyme') || lower.includes('enzymatic')) return 'envirozyme';

  return 'betco'; // default
}

/**
 * Determine if a product is discontinued based on Status field.
 *
 * Recognizes: 'Discontinued', 'DISC', 'D' (case-insensitive)
 * Returns false for null or unrecognized status.
 */
export function isProductDiscontinued(status: string | null | undefined): boolean {
  if (!status) return false;
  const upper = status.toUpperCase();
  return ['DISCONTINUED', 'DISC', 'D'].includes(upper);
}

/**
 * Determine if a product is marked as available on web.
 *
 * legacy.products."OnWeb" is integer 0/1 (B0-1089); only 1 means on web.
 */
export function isProductOnWeb(onWeb: number | null | undefined): boolean {
  return onWeb === 1;
}

/**
 * Extract photo URL from User_Str_00 field if it's a valid URL.
 *
 * Validates that the URL starts with 'http://' or 'https://'
 * Returns null if not a valid URL or null input.
 */
export function extractPhotoUrl(userStr00: string | null | undefined): string | null {
  if (!userStr00) return null;
  const trimmed = userStr00.trim();
  if (trimmed.match(/^https?:\/\//i)) {
    return trimmed;
  }
  return null;
}

/**
 * Build metadata JSONB object for a label based on legacy product data.
 *
 * Includes: brand, product_title, sku, status, photo_urls
 */
export function buildLabelMetadata(
  product: LegacyProductFields
): Record<string, unknown> {
  const brand = classifyProductBrand(product.DSLProdLn);
  const photoUrl = extractPhotoUrl(product.User_Str_00);

  return {
    product_title: product.Title,
    sku: product.SKU,
    brand,
    status: product.Status,
    photo_urls: photoUrl ? [photoUrl] : [],
  };
}

/**
 * SQL snippet to help identify which products should be ingested into rag.label.
 *
 * Use in Supabase SQL editor to audit active, web-visible products:
 * ```sql
 * SELECT * FROM legacy.products
 * WHERE "Status" IN ('Active', 'ACT', 'A')
 *   AND "OnWeb" = 1
 *   AND "ProductsKey" IS NOT NULL
 * LIMIT 100;
 * ```
 */
export const LABEL_INGESTION_QUERY_HELP = `
  -- SQL to find products ready for label ingestion
  SELECT
    "ProductsKey" as product_key,
    "Title" as title,
    "SKU" as sku,
    "DSLProdLn" as product_line,
    "Status" as status,
    "User_Str_00" as photo_url,
    CASE
      WHEN "DSLProdLn" LIKE '%1950%' THEN '1950'
      WHEN "DSLProdLn" LIKE '%Basic%' OR "DSLProdLn" LIKE '%BasicCoatings%' THEN 'basic_coatings'
      WHEN "DSLProdLn" LIKE '%EnviroZyme%' OR "DSLProdLn" LIKE '%Enzymatic%' THEN 'envirozyme'
      ELSE 'betco'
    END as brand,
    CASE
      WHEN "Status" IN ('Discontinued', 'DISC', 'D') THEN true
      ELSE false
    END as is_discontinued
  FROM legacy.products
  WHERE "Status" IN ('Active', 'ACT', 'A')
    AND "OnWeb" = 1
    AND "ProductsKey" IS NOT NULL
  ORDER BY "ProductsKey"
  LIMIT 5000;
`;
