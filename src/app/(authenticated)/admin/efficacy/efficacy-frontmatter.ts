// B0-797 — identifying fields lifted from an efficacy markdown document's YAML
// frontmatter into rag.document.metadata at ingest time.
//
// Why this is not optional: the shared S3 ingestion pipeline REPLACES
// document.metadata wholesale on every ingest, so any field it does not produce
// is dropped. Before this existed, a re-ingest silently deleted B0-232's
// metadata.formula_code — the field the efficacy retrieval path resolves a
// formula by — leaving the document unreachable until the backfill was re-run.
//
// `is_current` / `status` are deliberately NOT lifted. rag.document.is_current
// is B0-796's currency model; a second, stale copy of it in metadata would drift.

const EFFICACY_FRONTMATTER_FIELDS = [
  'formula_code',
  'product_name',
  'version',
  'project_number',
  'epa_reg_no',
  'lab',
  'report_date',
  'source_pdf',
] as const;

export type EfficacyFrontmatterField = (typeof EFFICACY_FRONTMATTER_FIELDS)[number];

/**
 * Minimal scalar reader for the flat, generated efficacy frontmatter block
 * (`key: value`, one per line, no nesting, no multi-line values). Returns only
 * the allow-listed identifying fields; a literal `null` becomes null.
 *
 * Values are taken verbatim apart from stripping surrounding quotes — these are
 * regulated identifiers (EPA reg numbers, project numbers, formula codes) and
 * must never be normalized, padded or reformatted here.
 */
export function parseEfficacyFrontmatter(
  markdown: string,
): Partial<Record<EfficacyFrontmatterField, string | null>> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }

  const parsed: Partial<Record<EfficacyFrontmatterField, string | null>> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (!(EFFICACY_FRONTMATTER_FIELDS as readonly string[]).includes(key)) {
      continue;
    }
    const rawValue = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    parsed[key as EfficacyFrontmatterField] =
      rawValue === '' || rawValue === 'null' ? null : rawValue;
  }
  return parsed;
}
