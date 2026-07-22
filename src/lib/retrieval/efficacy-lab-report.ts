import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-232/233/237/238 — the current, active lab-report document for a product line,
 * resolved via the formula<->product crosswalk (rag.efficacy_formula_product), with a
 * citable excerpt and provenance (lab, Project #, S3 source) for grounding Bex answers.
 *
 * This complements (does not replace) the pre-existing rag.product_efficacy structured
 * facts consumed by fetchFactsForProductLineKey() — that table has no formula_code, lab,
 * Project #, or version concept, so it can't carry a regulatorily-defensible citation.
 * Once the crosswalk (B0-232) is backfilled with real data, this becomes the primary,
 * citable source; product_efficacy remains a secondary/fallback grounding source.
 */
export type EfficacyLabReportCitation = {
  documentId: string;
  formulaCode: string | null;
  version: string | null;
  lab: string | null;
  projectNumber: string | null;
  isCurrent: boolean;
  /** Set when this (current) document reuses an earlier version's lab data verbatim (B0-233). */
  citesDataFromDocumentId: string | null;
  /** S3 URI of the raw source PDF/markdown, for the "links to the raw PDF in S3" requirement (B0-238). */
  sourceUri: string | null;
  title: string;
  excerpt: string;
};

type EfficacyDocumentRow = {
  id: string;
  title: string;
  source_record_id: string;
  is_current: boolean;
  cites_data_from_document_id: string | null;
  metadata: Record<string, unknown> | null;
  summary: string | null;
  body_text: string | null;
};

function readMetadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Resolve the primary registrant's product_line_key for a sub-registrant product
 * (B0-234): a sub-registrant's own SDS/label carries an EPA reg number with a
 * distributor segment (epa_registrant_role='sub'); the identical formulation is sold
 * under the primary holder's EPA reg number (same registrant prefix, no distributor
 * segment) on a *different* product line, whose crosswalk entry is the one that's
 * actually populated. Returns null when no such sibling is found.
 */
async function resolvePrimaryRegistrantProductLineKey(
  productLineKey: string,
): Promise<string | null> {
  const rag = getSupabaseServiceRoleClient().schema('rag');

  const { data: subDoc } = await rag
    .from('document')
    .select('epa_registrant, epa_registrant_role, entity_id')
    .in('document_kind', ['sds', 'label'])
    .eq('epa_registrant_role', 'sub')
    .not('entity_id', 'is', null)
    .limit(200);

  if (!subDoc || subDoc.length === 0) return null;

  // Narrow to documents whose entity resolves to this product line.
  const { data: entities } = await rag
    .from('entity')
    .select('id')
    .eq('entity_type', 'product_line')
    .eq('product_line_key', productLineKey)
    .limit(5);
  const entityIds = new Set((entities ?? []).map((e) => e.id));
  const matchingSubRow = subDoc.find((row) => row.entity_id && entityIds.has(row.entity_id));
  const registrantPrefix = matchingSubRow?.epa_registrant;
  if (!registrantPrefix) return null;

  const { data: primaryDoc } = await rag
    .from('document')
    .select('entity_id')
    .in('document_kind', ['sds', 'label'])
    .eq('epa_registrant', registrantPrefix)
    .eq('epa_registrant_role', 'primary')
    .not('entity_id', 'is', null)
    .limit(1)
    .maybeSingle();
  if (!primaryDoc?.entity_id) return null;

  const { data: primaryEntity } = await rag
    .from('entity')
    .select('product_line_key')
    .eq('id', primaryDoc.entity_id)
    .maybeSingle();

  return primaryEntity?.product_line_key ?? null;
}

async function fetchCurrentEfficacyDocuments(
  productLineKey: string,
): Promise<EfficacyDocumentRow[]> {
  const rag = getSupabaseServiceRoleClient().schema('rag');
  const { data, error } = await rag.rpc('get_current_efficacy_for_product', {
    p_product_line_key: productLineKey,
  });
  if (error || !data) return [];
  return data as EfficacyDocumentRow[];
}

async function buildCitation(
  doc: EfficacyDocumentRow,
  organism?: string,
): Promise<EfficacyLabReportCitation | null> {
  const rag = getSupabaseServiceRoleClient().schema('rag');

  const [{ data: sourceRecord }, { data: chunks }] = await Promise.all([
    rag.from('source_record').select('source_uri').eq('id', doc.source_record_id).maybeSingle(),
    rag
      .from('document_chunk')
      .select('chunk_text')
      .eq('document_id', doc.id)
      .order('chunk_index', { ascending: true })
      .limit(50),
  ]);

  const needle = organism?.trim().toLowerCase();
  const chunkRows = (chunks ?? []) as Array<{ chunk_text: string }>;
  const matched = needle
    ? chunkRows.find((c) => c.chunk_text.toLowerCase().includes(needle))
    : undefined;
  const excerpt =
    (matched ?? chunkRows[0])?.chunk_text ?? doc.summary ?? doc.body_text?.slice(0, 900) ?? '';

  // Nothing citable yet (document registered but not chunked/summarized) — do not
  // fabricate a citation from an empty excerpt.
  if (!excerpt.trim()) return null;

  const metadata = doc.metadata;

  return {
    documentId: doc.id,
    formulaCode: readMetadataString(metadata, 'formula_code'),
    version: readMetadataString(metadata, 'version'),
    lab: readMetadataString(metadata, 'third_party_lab') ?? readMetadataString(metadata, 'lab'),
    projectNumber: readMetadataString(metadata, 'project_number'),
    isCurrent: doc.is_current,
    citesDataFromDocumentId: doc.cites_data_from_document_id,
    sourceUri: sourceRecord?.source_uri ?? null,
    title: doc.title,
    excerpt,
  };
}

/**
 * Fetch the current, active lab-report citation for a product line, optionally
 * filtered toward an organism-specific excerpt. Falls back to the primary
 * registrant's crosswalk entry for sub-registrant products (B0-234) when the given
 * product line has no direct crosswalk row of its own. Returns null when no formula
 * is linked (crosswalk not backfilled, or genuinely no efficacy corpus for this line)
 * — callers must treat this the same as "no verified data on file", never estimate.
 */
export async function fetchCurrentEfficacyLabReport(
  productLineKey: string,
  organism?: string,
): Promise<EfficacyLabReportCitation | null> {
  let docs = await fetchCurrentEfficacyDocuments(productLineKey);

  if (docs.length === 0) {
    const primaryProductLineKey = await resolvePrimaryRegistrantProductLineKey(productLineKey);
    if (primaryProductLineKey) {
      docs = await fetchCurrentEfficacyDocuments(primaryProductLineKey);
    }
  }

  if (docs.length === 0) return null;

  // TODO(B0-232): a product can cite multiple formulas over time; today this takes
  // the first current document returned. Revisit once real crosswalk data exists and
  // we can tell whether "most recent effective_at" or an explicit primary flag is the
  // right tie-break.
  return buildCitation(docs[0], organism);
}

/**
 * Render a citable markdown block for an efficacy lab-report, matching the format of
 * buildFactsBlock() in product-facts.ts so both blocks compose cleanly in one answer.
 */
export function renderEfficacyLabReportCitation(citation: EfficacyLabReportCitation): string {
  const lines: string[] = ['### Lab Report Citation'];

  if (citation.formulaCode) {
    lines.push(
      `- **Formula:** ${citation.formulaCode}${citation.version ? ` (version ${citation.version})` : ''}`,
    );
  }
  if (citation.lab) lines.push(`- **Lab:** ${citation.lab}`);
  if (citation.projectNumber) lines.push(`- **Project #:** ${citation.projectNumber}`);
  if (citation.sourceUri) lines.push(`- **Source (raw PDF):** ${citation.sourceUri}`);
  if (citation.citesDataFromDocumentId) {
    lines.push(
      '- **Note:** this current formulation reuses an earlier tested version\'s lab data; the citation above is for the version that actually generated these numbers.',
    );
  }

  lines.push('', citation.excerpt);

  return lines.join('\n');
}
