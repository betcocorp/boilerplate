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

export type EfficacyDocumentRow = {
  id: string;
  title: string;
  source_record_id: string;
  is_current: boolean;
  cites_data_from_document_id: string | null;
  metadata: Record<string, unknown> | null;
  source_lab: string | null;
  project_number: string | null;
  summary: string | null;
  body_text: string | null;
  /** B0-796 AC2 tie-break key — see pickMostCurrentDocument(). */
  created_at: string | null;
};

function readMetadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * B0-802 — reduces a formula code to the bare product-code qualifier a
 * "TABLE n: CALCULATED DATA FOR <qualifier ...>" heading actually names, so a
 * shared lab report covering several formulas can be disambiguated to the one this
 * document itself is linked to. M000796 -> "796" (same reduction the B0-232
 * crosswalk backfill uses for the same corpus); a bare product code (legacy/
 * disinfectant corpora, whose formula code already IS the product code) is
 * returned upper-cased unchanged.
 */
export function extractProductQualifier(formulaCode: string | null): string | null {
  if (!formulaCode) return null;
  const upper = formulaCode.trim().toUpperCase();
  const match = upper.match(/^M0*(\d+)$/);
  return match ? match[1] : upper || null;
}

/**
 * B0-802 — true only when `chunkText` contains a "TABLE n: CALCULATED DATA FOR
 * ..." heading whose product/formula description names `qualifier` as a whole
 * word (word-boundaried so "796" doesn't match inside "17960"). This is the
 * actual results table (log reduction / percent reduction), not the "TEST
 * RESULTS FOR" raw-count table or a "CONTROL RESULTS" table that happens to also
 * list the organism.
 */
export function isCalculatedDataTableForQualifier(chunkText: string, qualifier: string | null): boolean {
  if (!qualifier) return false;
  const heading = chunkText.match(/table\s+\d+:\s*calculated data for\s+([^\n]+)/i)?.[1];
  if (!heading) return false;
  return new RegExp(`\\b${escapeRegExp(qualifier)}\\b`, 'i').test(heading);
}

/**
 * B0-796 AC2 — deterministic tie-break when more than one `is_current = true`
 * efficacy document remains for a product line (still legitimate after the
 * currency reconciliation: e.g. two genuinely-current formulas, or a sibling
 * whose frontmatter currency is UNKNOWN and therefore was never touched). Never
 * rely on the RPC's return order (docs[0]).
 *
 * Picks the most recently created row. rag.document carries no authoritative
 * "effective date" column; `created_at` is the best available signal, and for
 * this corpus it is a *verified* one — ingestion order tracks each formula's own
 * version history (e.g. M000796's Version 0 -> Version 6 rows were inserted with
 * strictly increasing created_at, in step with the version number). Falls back
 * to `id` for a fully deterministic order on an exact created_at tie.
 */
export function pickMostCurrentDocument(docs: EfficacyDocumentRow[]): EfficacyDocumentRow {
  return [...docs].sort((a, b) => {
    const byCreatedAt = (b.created_at ?? '').localeCompare(a.created_at ?? '');
    if (byCreatedAt !== 0) return byCreatedAt;
    return a.id.localeCompare(b.id);
  })[0];
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
  return (data as unknown as EfficacyDocumentRow[]);
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
  const qualifier = extractProductQualifier(readMetadataString(doc.metadata, 'formula_code'));

  // B0-802: a lab-report document can carry several "TABLE n: CALCULATED DATA
  // FOR <formula>" blocks for DIFFERENT formulas sharing one test panel (e.g. the
  // M000796 document also carries 795's and 797's calculated-data tables) — the
  // same organism can legitimately appear in more than one of them. Prefer the
  // table that belongs to THIS document's own formula/product qualifier first;
  // only fall back to a bare organism match (pre-B0-802 behavior) when no
  // qualifier is available (single-formula legacy/disinfectant docs) or no
  // qualifier-scoped table matched at all — never silently accept a different
  // formula's table when a qualifier match exists.
  let matched: { chunk_text: string } | undefined;
  if (qualifier) {
    matched = chunkRows.find(
      (c) =>
        isCalculatedDataTableForQualifier(c.chunk_text, qualifier) &&
        (!needle || c.chunk_text.toLowerCase().includes(needle)),
    );
  }
  if (!matched && needle) {
    matched = chunkRows.find((c) => c.chunk_text.toLowerCase().includes(needle));
  }
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
    lab: doc.source_lab ?? readMetadataString(metadata, 'third_party_lab') ?? readMetadataString(metadata, 'lab'),
    projectNumber: doc.project_number ?? readMetadataString(metadata, 'project_number'),
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

  // B0-796 AC2: more than one is_current=true row can legitimately remain for a
  // product line even after currency reconciliation — never rely on the RPC's
  // return order. See pickMostCurrentDocument() for the tie-break rule.
  return buildCitation(pickMostCurrentDocument(docs), organism);
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

  // B0-802: the model comprehends this excerpt as free text — there is no structured
  // log-reduction/NR parser in the pipeline. Without an explicit instruction, a "No
  // Reduction" / "NR" / blank Log Reduction or Percent Reduction cell has been read as
  // an affirmative kill claim. This line travels with the excerpt through every path
  // that renders this citation (single- and batch-product `get_efficacy_data`), so the
  // guardrail is present wherever the model actually sees the table.
  lines.push(
    '',
    '**Reading this table:** "No Reduction", "NR", or a blank Log Reduction / Percent Reduction cell means the tested product did NOT demonstrate a measurable reduction for that organism at that contact time. State that absence exactly as printed, or say the verified data does not support a reduction claim — never invert it into a positive/affirmative "yes, it kills X" claim.',
  );
  lines.push('', citation.excerpt);

  return lines.join('\n');
}
