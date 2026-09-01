import {
  retrieveApprovedUsage,
  retrieveCompatibility,
  retrieveSafetyConstraints,
  retrieveSurfacesLists,
} from '~/lib/retrieval/product-guidance';
import { ragQueryForProductKnowledgeWithMeta } from '~/lib/retrieval/product-knowledge';
import {
  buildFactsBlock,
  fetchFactsForProductLineKey,
  fetchFactsForProductLineKeys,
  type ProductLineFacts,
} from '~/lib/retrieval/product-facts';
import {
  fetchCurrentEfficacyLabReport,
  renderEfficacyLabReportCitation,
  type EfficacyLabReportCitation,
} from '~/lib/retrieval/efficacy-lab-report';
import {
  fetchFastDrawDilution,
  type FastDrawDilutionLookup,
} from '~/lib/retrieval/fastdraw-dilution';
import { VERIFIED_FACTS_SOURCE_ID } from '~/lib/rag/document-chunk-types';
import {
  resolveProductEntityByName,
  type ProductEntityResolutionMode,
  type ProductEntityResolutionResult,
  type ResolveProductEntityOptions,
} from '~/lib/rag/entity-context';
import {
  inferSectionTypeFromQuery,
  inferSectionTypeFromToolName,
} from '~/lib/rag/section-type-inference';
import { writeAuditLog, type AuditContext } from '~/lib/audit/audit-log';

import {
  buildKnowledgeAssetQuery,
  KNOWLEDGE_ASSET_ADAPTER_TAG,
  retrieveKnowledgeAssets,
} from '~/lib/retrieval/knowledge-assets';

import {
  EFFICACY_BATCH_MAX_PRODUCTS,
  findProductsByCategoryInputSchema,
  getApprovedUsageGuidanceInputSchema,
  getCompatibilityRulesInputSchema,
  getDispenserAssetInputSchema,
  getEfficacyDataInputSchema,
  getEscalationPolicyInputSchema,
  getFloorAssetInputSchema,
  getProductCategoryInputSchema,
  getProductSpecInputSchema,
  getProductsInCategoryInputSchema,
  getSafetyConstraintsInputSchema,
  listAllowedSurfacesInputSchema,
  listDisallowedUsesInputSchema,
  lookupCrossReferenceInputSchema,
  recommendCrossReferenceInputSchema,
  searchProductDocsInputSchema,
  type ProductToolName,
} from '~/lib/tools/tool-schemas';
import { lookupCrossReferenceDeduped } from '~/lib/recommendations/legacy-lookup-cache';
import { getProductCategory, getProductsInCategory } from '~/lib/tools/category-lookup';
import { routeCategoryQuery } from '~/lib/category/category-router';
import { runCrossReferenceRecommendation } from '~/lib/recommendations/persist-recommendation';

const ADAPTER_TAG = 'rag_corpus_full_document' as const;

/**
 * B0-780 — category-binding: `vct` and `sportszone` are mutually exclusive floor-care domains in
 * the `knowledge` corpus (resilient tile vs. wood sport floors — see `deriveKnowledgeCategoryFromS3Key`
 * in `~/lib/rag/search.ts`), and `restroom` is out of scope for either. A wood-sport-floor question
 * must never ground on a VCT procedure document (and vice versa), and a bathroom-specialist question
 * must never ground on floor-care content at all.
 *
 * Deliberately keyword-based and deliberately narrow: an AMBIGUOUS or neither-signal floor query
 * (e.g. "how do I select a floor finish" with no substrate named) excludes nothing, so it keeps
 * behaving exactly as before this ticket. Only a query that actually names one domain gets bound
 * away from the other.
 */
const WOOD_FLOOR_QUERY_PATTERN =
  /\bwood(?:en)?\b|\bhardwood\b|\bgym(?:nasium)?s?\b|\bsport(?:s)?\s*(?:zone|floor|court)\b|\bmaple\b|\bathletic floor\b/i;
const VCT_FLOOR_QUERY_PATTERN =
  /\bvct\b|\bvinyl composition tile\b|\bvinyl tile\b|\bresilient tile\b|\bmastic\b/i;

/** B0-780 — a bathroom-specialist call never needs floor-care content, regardless of query wording. */
const BATHROOM_EXCLUDED_KNOWLEDGE_CATEGORIES = ['vct', 'sportszone'] as const;

/**
 * B0-780 — resolves which `knowledge` document categories (see `deriveKnowledgeCategoryFromS3Key`)
 * to exclude from retrieval for this call, from the specialist policy actually running
 * (`auditCtx.specialistId`, threaded from `run-product-support-workflow.ts`'s `effectivePromptId`
 * via `wfCtx`) and the text of this specific call's query.
 *
 * `dilution-control` and `product` are cross-cutting categories and are never excluded here, for
 * any specialist.
 */
export function resolveKnowledgeCategoryExclusions(
  specialistId: string | null | undefined,
  queryText: string,
): string[] {
  if (specialistId === 'bathroom') {
    return [...BATHROOM_EXCLUDED_KNOWLEDGE_CATEGORIES];
  }
  if (specialistId === 'floor') {
    const isWoodDomain = WOOD_FLOOR_QUERY_PATTERN.test(queryText);
    const isVctDomain = VCT_FLOOR_QUERY_PATTERN.test(queryText);
    if (isWoodDomain && !isVctDomain) {
      return ['vct'];
    }
    if (isVctDomain && !isWoodDomain) {
      return ['sportszone'];
    }
  }
  return [];
}

/**
 * B0-488 — the eval-harness / audit-log outcome taxonomy for `rag.product_alias` resolution,
 * distinct from `ProductEntityResolutionSource` (which also names the non-alias legacy fallback
 * tiers, `prod_line_id`/`title_exact`/`title_fuzzy`). `alias_fuzzy` here covers BOTH the tokenized
 * (`alias_fuzzy`) and trigram-RPC (`alias_fuzzy_trgm`) tiers — the ticket's outcome categories
 * don't split those further.
 */
export type AliasResolutionOutcome = 'alias_exact' | 'alias_fuzzy' | 'no_alias_match' | 'ambiguous_alias';

/**
 * Per-call alias-resolution telemetry, attached near the front of every product-tool's JSON
 * payload (see `resolveProductEntityWithAliasTelemetry` below) so it survives the 4,000-char
 * `outputPreview` truncation applied when the call is persisted onto the workflow's tool trace
 * (`~/lib/tools/execute-tool-call.ts`) — `~/lib/tests/alias-routing.ts` reads it back from there
 * for the `/admin/tests` hit-rate metric.
 */
export type AliasResolutionTelemetry = {
  /** False when the caller passed an empty/whitespace-only name — nothing was attempted. */
  attempted: boolean;
  /** Null only when `attempted` is false. */
  outcome: AliasResolutionOutcome | null;
  /**
   * B0-479: which resolution mode produced `outcome` — `'name'` for a model-asserted product
   * name/code, `'freeform'` for a precise-tiers-only attempt against raw `freeformQuery` text.
   * `computeAliasResolutionReport` (`~/lib/tests/alias-routing.ts`) intentionally ignores this and
   * pools both modes into one hit rate; it's carried so a trace can still be read back per-mode
   * (freeform attempts are expected to miss far more often — most freeform queries name no product).
   */
  mode: ProductEntityResolutionMode;
};

function classifyAliasResolutionOutcome(
  resolution: Pick<ProductEntityResolutionResult, 'resolutionSource' | 'ambiguousAlias'>,
): AliasResolutionOutcome {
  if (
    resolution.resolutionSource === 'alias_exact' ||
    resolution.resolutionSource === 'alias_exact_freeform'
  ) {
    return 'alias_exact';
  }
  if (
    resolution.resolutionSource === 'alias_fuzzy' ||
    resolution.resolutionSource === 'alias_fuzzy_freeform' ||
    resolution.resolutionSource === 'alias_fuzzy_trgm'
  ) {
    return 'alias_fuzzy';
  }
  if (resolution.ambiguousAlias) {
    return 'ambiguous_alias';
  }
  return 'no_alias_match';
}

/**
 * B0-488 — wraps `resolveProductEntityByName` for every product-tool call site: attaches the
 * `AliasResolutionTelemetry` returned to the model/harness, and — on an actual alias hit (exact or
 * fuzzy) — writes an `audit_logs` row via the existing `writeAuditLog` helper.
 *
 * Logged here, not inside `~/lib/rag/entity-context.ts`: that module is a low-level DB helper with
 * no `AuditContext` (traceId/workflowRunId) in scope, called from several places. This call site
 * (reached via `executeToolCall` <- the `executeTool` closure in
 * `~/lib/workflows/product-support/run-product-support-workflow.ts`) does have one, threaded down
 * as `auditCtx`.
 *
 * Uses the immediate `writeAuditLog` helper rather than that workflow's `AuditLogQueue`: the queue
 * instance lives inside the workflow's closure and isn't threaded this far down, and an alias hit
 * is relatively rare (most tool calls carry no explicit product name at all), so the extra insert
 * latency only lands on that minority hit path, not on every tool call.
 */
async function resolveProductEntityWithAliasTelemetry(
  nameOrId: string,
  toolName: string,
  auditCtx: AuditContext | undefined,
  /** B0-479: `{ mode: 'freeform' }` for a precise-tiers-only attempt against raw user text. */
  options: ResolveProductEntityOptions = { mode: 'name' },
): Promise<ProductEntityResolutionResult & { aliasResolution: AliasResolutionTelemetry }> {
  const mode: ProductEntityResolutionMode = options.mode ?? 'name';
  const resolution = await resolveProductEntityByName(nameOrId, options);
  const attempted = nameOrId.trim().length > 0;
  const outcome = attempted ? classifyAliasResolutionOutcome(resolution) : null;

  if (attempted && auditCtx && (outcome === 'alias_exact' || outcome === 'alias_fuzzy')) {
    await writeAuditLog(
      'alias_resolution_hit',
      {
        query: nameOrId,
        resolution_source: resolution.resolutionSource,
        matched_alias_id: resolution.matchedAliasId,
        matched_alias_confidence: resolution.matchedAliasConfidence,
        product_line_key: resolution.productLineKey,
        product_key: resolution.productKey,
      },
      { ...auditCtx, toolName },
    );
  }

  return { ...resolution, aliasResolution: { attempted, outcome, mode } };
}

/**
 * Each "source" is a full document (assembled from all its chunks). The model is
 * expected to read `documentBody` for grounding and use `snippet` only as a
 * preview / citation hint.
 *
 * B0-548: no longer also emits `matchedChunkText` — it duplicated content already in
 * `documentBody` (or, when body assembly fell back to the single matched chunk, was
 * byte-identical to it) and had no downstream reader, so it was pure token/storage waste on
 * the persisted payload (`toolOutputLog`, `outputPreview`). `documentBody` (full grounding
 * text) and `snippet` (bounded preview persisted for UI citations by
 * `collectSourcesFromToolOutputs`/`collectSourceMetaFromToolOutputs`) remain distinct and
 * both still have real consumers.
 */
function sourcePayload(
  result: Awaited<ReturnType<typeof ragQueryForProductKnowledgeWithMeta>>,
) {
  const docs = result.sources.map((s) => ({
    documentId: s.documentId,
    chunkId: s.chunkId,
    title: s.title,
    snippet: s.snippet,
    documentBody: s.documentBody,
    documentBodyChars: s.documentBodyChars,
    documentBodyChunkCount: s.documentBodyChunkCount,
    documentBodyTruncated: s.documentBodyTruncated,
    documentBodyTokenEstimate: s.documentBodyTokenEstimate,
    // B0-13: full list of chunk ids assembled into documentBody, so a retrieval can be
    // audited after the fact (e.g. confirming a specific label section reached the model
    // vs. was dropped by the per-document truncation cap in assembleDocumentBodies()).
    documentBodyChunkIds: s.documentBodyChunkIds,
    // B0-490 — `similarity` is the unambiguous key (the raw pgvector/hybrid score for the
    // surviving match); `confidence` is kept alongside it for back-compat with any reader still
    // keying off the old name, but is never the field a NEW reader should source from.
    similarity: s.similarity,
    confidence: s.similarity,
    documentKind: s.documentKind,
    productLineKey: s.productLineKey,
    productKey: s.productKey,
    // B0-257: raw S3 location of the source PDF/markdown, so label/SDS-derived answers
    // (directions, hazards, first aid, dilution) can cite the exact source document.
    s3Key: s.s3Key,
    sourceUri: s.sourceUri,
    freshness: null as null,
  }));

  // B0-196: surface structured facts as a first-class grounded source so both the
  // model and the validator's evidence summary (built from sources[].documentBody)
  // treat verified dilution/efficacy values as citable evidence.
  if (result.factsBlock) {
    docs.unshift({
      documentId: VERIFIED_FACTS_SOURCE_ID,
      chunkId: VERIFIED_FACTS_SOURCE_ID,
      title: 'Verified Product Facts (structured)',
      snippet: result.factsBlock.slice(0, 900),
      documentBody: result.factsBlock,
      documentBodyChars: result.factsBlock.length,
      documentBodyChunkCount: 1,
      documentBodyTruncated: false,
      documentBodyTokenEstimate: null,
      documentBodyChunkIds: [VERIFIED_FACTS_SOURCE_ID],
      similarity: 1,
      confidence: 1,
      documentKind: 'facts',
      productLineKey: null,
      productKey: null,
      s3Key: null,
      sourceUri: null,
      freshness: null as null,
    });
  }

  return docs;
}

/**
 * B0-636 — citation entry for a FastDraw-dispenser dilution/yield chunk, pushed onto `sources[]`
 * the same way `get_efficacy_data` already cites "Verified Product Facts (structured)" and the
 * efficacy lab report — a distinctly titled entry so the model can tell the two dilution contexts
 * apart rather than treating them as one value.
 */
function fastDrawDilutionSourceEntry(lookup: FastDrawDilutionLookup) {
  return {
    documentId: lookup.documentId,
    chunkId: lookup.chunkId,
    title: 'FastDraw Dispenser Dilution (structured)',
    snippet: lookup.documentBody.slice(0, 900),
    documentBody: lookup.documentBody,
    documentKind: 'fastdraw_dilution',
    similarity: 1,
    confidence: 1,
  };
}

const ESCALATION_MAP: Record<string, { summary: string; steps: string[] }> = {
  default: {
    summary: 'Standard product-support escalation.',
    steps: [
      'Capture exact product name/SKU and surface/material.',
      'If safety-critical or unclear from approved docs, route to human product specialist.',
      'Do not speculate on off-label use.',
    ],
  },
  safety: {
    summary: 'Safety or exposure concern.',
    steps: [
      'Refer to SDS and label; recommend medical advice for health incidents.',
      'Escalate to EHS / safety contact per account rules.',
    ],
  },
  compatibility: {
    summary: 'Surface or material compatibility uncertain.',
    steps: [
      'Verify with approved documentation only; if absent, recommend spot test per label or escalate.',
    ],
  },
};

function escalationForIssueType(raw: string) {
  const key = raw.trim().toLowerCase();
  if (
    key.includes('safety') ||
    key.includes('exposure') ||
    key.includes('sds')
  ) {
    return ESCALATION_MAP.safety;
  }
  if (
    key.includes('compat') ||
    key.includes('surface') ||
    key.includes('material')
  ) {
    return ESCALATION_MAP.compatibility;
  }
  return ESCALATION_MAP.default;
}

/**
 * B0-759 — question shapes whose answer is an enumeration or a procedure: a maintenance
 * schedule, a list of failure causes, a dry/recoat window. These need DEPTH from one procedural
 * document, which is the opposite of what the default gives them.
 *
 * Matched against the raw query, so keep every pattern anchored on an interrogative opener rather
 * than a bare noun — `\bmaintenance\b` alone would fire on "what dilution does the maintenance
 * cleaner use", a single-value lookup that is well served by the default breadth.
 */
const PROCEDURAL_DEPTH_PATTERNS: readonly RegExp[] = [
  /\bwhat\s+(factors|causes|kinds?\s+of|types?\s+of|sorts?\s+of)\b/,
  /\b(what|which)\b[^.?!]{0,16}\bsteps\b/,
  /\bwhat\s+maintenance\b/,
  /\bmaintenance\s+(schedule|checklist|routine|plan|interval)\b/,
  /\bhow\s+(often|long|soon)\b/,
  /\bstep[-\s]by[-\s]step\b/,
  /\bchecklist\b/,
  /**
   * B0-759 follow-up — "which X get missed most often" is an enumeration ask wearing a question
   * word: the graded answer is a list of fixtures, not a single fact.
   *
   * B0-781 — added the adjectival "most common" alongside the adverbial "most often/most
   * commonly": RST-016 ("What are the most common mistakes staff make when cleaning restrooms?",
   * 9-concept golden answer) used the adjectival form and matched none of the original four.
   */
  /\b(which|what)\b[^.?!]{0,40}\b(most often|most commonly|commonly|typically|most common)\b/,
  /**
   * A hard superlative ("strongest stripper you have") cannot be answered by naming one product —
   * Betco publishes no performance ranking, so the answer has to enumerate the labeled options and
   * decline to rank them, which needs several of them retrieved. Deliberately excludes "best",
   * which appears in already-passing single-product asks like "what is the best glass cleaner".
   */
  /\b(strongest|toughest|most\s+aggressive|most\s+powerful|heaviest[-\s]duty)\b/,
  /**
   * B0-781 — troubleshooting-cause phrasing: "why didn't/doesn't/wasn't X" asks for the set of
   * possible causes of an observed failure, not one fact (VCT-003: "Why didn't all the finish come
   * off when I stripped the VCT floor?", 7 documented causes in one procedural document).
   */
  /\bwhy\s+(?:didn'?t|doesn'?t|wasn'?t|isn'?t|hasn'?t|won'?t)\b/,
  /**
   * B0-784 — a compound-subject verification question ("do/does X AND Y both/actually work...")
   * names two distinct product categories and needs a document that covers both, not the single
   * narrowest-matching product doc. VCT-087 ("Do green-certified finishes and strippers actually
   * work as well on VCT?") has an exact-topic answer in one knowledge document ("VCT Green
   * Certified"), but at the default breadth the narrower per-product stripper docs (much stronger
   * lexical overlap on "stripper") crowded it out of the returned set entirely — this widens the
   * candidate pool so the actually-relevant generic document has a chance to surface.
   */
  /\b(?:do|does|did)\b[^.?!]{0,40}\band\b[^.?!]{0,60}\b(?:work|perform|hold up|clean(?:s)?\s+as\s+well|last(?:s)?\s+as\s+long)\b/,
];

/**
 * B0-201: derive curation knobs from query intent. Single-product deep-dives get more facets
 * of one line; comparisons surface several distinct lines. Undefined fields = pipeline defaults.
 */
/** Exported only so the B0-759 regression test can pin which shapes do and do not widen. */
export function classifyRetrievalIntent(
  query: string,
  productName?: string,
): { limit?: number; maxPerDocument?: number; requiredDocumentKinds?: string[] } {
  const q = query.toLowerCase();
  if (/\bvs\.?\b|\bversus\b|\bcompare\b|\bdifference between\b/.test(q)) {
    return { limit: 5, maxPerDocument: 1, requiredDocumentKinds: ['product_line_profile'] };
  }
  if (productName && productName.trim()) {
    return { limit: 4, maxPerDocument: 2 };
  }
  /**
   * B0-759 — deliberately AFTER the product-name branch, so a named product keeps the tuning it
   * has today and this only affects queries that would otherwise inherit the bare 3x1 default.
   *
   * WIDTH ONLY — `maxPerDocument` is deliberately NOT raised, and this was measured, not assumed.
   * The first version returned `maxPerDocument: 3` on the theory that a fifteen-step schedule
   * needs several excerpts of the one document holding it. Run f08f12a0 (the first run where it
   * actually reached retrieval) refuted that: letting one document claim three of the six slots
   * crowds the others out, and answers that span several documents lost badly —
   * "what factors can throw off dilution accuracy", whose graded answer covers four distinct
   * areas, fell 67 -> 50, and the recoat-window question fell 69 -> 58 on 30,667 characters of
   * evidence, more than twice what it had when it scored higher. Only the single-document
   * enumeration gained ("which high-touch points get missed most often", 68 -> 96/99), and that
   * gain came from the width increase, which it had never had before.
   *
   * Net: `limit 6` with the default `maxPerDocument` graded 79.6 with no F; adding depth graded
   * 79.1 with two. Raise width here; do not raise depth without evidence for the specific shape.
   */
  if (PROCEDURAL_DEPTH_PATTERNS.some((pattern) => pattern.test(q))) {
    return { limit: 6 };
  }
  return {};
}

/**
 * B0-549 — resolves a batch `get_efficacy_data` call's product set to a flat list of
 * name/code identifiers, each still resolved individually via `resolveProductEntityWithAliasTelemetry`
 * (same alias/fuzzy resolution every other product-tool call goes through — a category lookup only
 * replaces how the identifier LIST is produced, not how each one is resolved to a product line).
 */
async function resolveBatchProductIdentifiers(p: {
  productIds?: string[];
  category?: string;
  categoryLevel?: 'prod_type' | 'sub_prod_type' | 'sub_child_prod_type' | 'prod_class' | 'any';
}): Promise<string[]> {
  if (p.productIds && p.productIds.length > 0) {
    return p.productIds;
  }
  if (p.category?.trim()) {
    const categoryResult = await getProductsInCategory({
      categoryName: p.category,
      categoryLevel: p.categoryLevel,
      maxResults: EFFICACY_BATCH_MAX_PRODUCTS,
    });
    return categoryResult.products
      .map((product) => product.productLineName?.trim() || product.productLineId?.trim() || '')
      .filter((identifier): identifier is string => identifier.length > 0);
  }
  return [];
}

/**
 * B0-549 — batch variant of the `get_efficacy_data` single-product path below: collapses what
 * would otherwise be N sequential `get_efficacy_data` tool calls (worst observed case: 27 in one
 * turn) into one call. Facts are fetched for every resolved product line in a SINGLE batched query
 * (`fetchFactsForProductLineKeys`); lab-report citations still require one lookup per product line
 * (no batched RPC exists for that yet) but those lookups run concurrently via `Promise.all` rather
 * than sequentially, so wall-clock time tracks the slowest single lookup, not their sum.
 */
async function executeBatchEfficacyData(
  p: {
    productIds?: string[];
    category?: string;
    categoryLevel?: 'prod_type' | 'sub_prod_type' | 'sub_child_prod_type' | 'prod_class' | 'any';
    organism?: string;
  },
  toolName: string,
  auditCtx: AuditContext | undefined,
): Promise<Record<string, unknown>> {
  const identifiers = await resolveBatchProductIdentifiers(p);

  if (identifiers.length === 0) {
    return {
      ok: true,
      adapter: 'structured_facts_batch_v1',
      batch: true,
      organism: p.organism ?? null,
      requestedCount: 0,
      resolvedCount: 0,
      results: [],
      sources: [],
      note: p.category?.trim()
        ? `No products found in category "${p.category}".`
        : 'No product identifiers resolved for this batch call.',
    };
  }

  const resolutions = await Promise.all(
    identifiers.map(async (identifier) => ({
      identifier,
      resolution: await resolveProductEntityWithAliasTelemetry(identifier, toolName, auditCtx),
    })),
  );

  const productLineKeys = [
    ...new Set(
      resolutions
        .map((r) => r.resolution.productLineKey)
        .filter((key): key is string => Boolean(key)),
    ),
  ];

  const [factsByLineKey, labReportEntries] = await Promise.all([
    fetchFactsForProductLineKeys(productLineKeys, p.organism),
    Promise.all(
      productLineKeys.map(
        async (key) => [key, await fetchCurrentEfficacyLabReport(key, p.organism)] as const,
      ),
    ),
  ]);
  const labReportByLineKey = new Map(labReportEntries);

  const sources: Record<string, unknown>[] = [];
  const results = resolutions.map(({ identifier, resolution }) => {
    const { productLineKey, aliasResolution } = resolution;
    const facts: ProductLineFacts | null =
      (productLineKey && factsByLineKey.get(productLineKey)) || null;
    const labReport: EfficacyLabReportCitation | null =
      (productLineKey && labReportByLineKey.get(productLineKey)) || null;

    if (facts) {
      const factsBlock = buildFactsBlock(
        new Map([[facts.entityId, facts]]),
        new Map([[facts.entityId, identifier]]),
      );
      if (factsBlock) {
        // B0-549: each product's facts source needs its own documentId — reusing the single
        // VERIFIED_FACTS_SOURCE_ID sentinel across every product in the batch would collide under
        // `collectSourceMetaFromToolOutputs`'s per-documentId dedupe and silently drop every
        // product but one from the citable evidence.
        sources.push({
          documentId: `${VERIFIED_FACTS_SOURCE_ID}:${productLineKey}`,
          chunkId: `${VERIFIED_FACTS_SOURCE_ID}:${productLineKey}`,
          title: `Verified Product Facts (structured) — ${identifier}`,
          snippet: factsBlock.slice(0, 900),
          documentBody: factsBlock,
          documentKind: 'facts',
          confidence: 1,
        });
      }
    }

    if (labReport) {
      const labReportBlock = renderEfficacyLabReportCitation(labReport);
      sources.push({
        documentId: labReport.documentId,
        chunkId: labReport.documentId,
        title: labReport.title,
        snippet: labReportBlock.slice(0, 900),
        documentBody: labReportBlock,
        documentKind: 'efficacy',
        confidence: 1,
      });
    }

    return {
      productId: identifier,
      productLineKey,
      aliasResolution,
      facts,
      labReport,
      ...(facts || labReport
        ? {}
        : {
            note: 'No verified dilution/efficacy data on file for this product. Do not estimate or infer a value — tell the user the data is not verified.',
          }),
    };
  });

  return {
    ok: true,
    adapter: 'structured_facts_batch_v1',
    batch: true,
    organism: p.organism ?? null,
    requestedCount: identifiers.length,
    resolvedCount: productLineKeys.length,
    results,
    sources,
  };
}

export async function executeProductTool(
  name: ProductToolName,
  args: unknown,
  /** B0-488: threaded from `executeToolCall` (which run-product-support-workflow.ts's `executeTool`
   * closure calls with its `wfCtx`), so an alias-resolution hit can be audit-logged. Undefined for
   * callers that don't have one (e.g. unit tests) — alias-resolution telemetry is still attached to
   * the returned payload, only the audit-log write is skipped. */
  auditCtx?: AuditContext,
): Promise<Record<string, unknown>> {
  switch (name) {
    case 'search_product_docs': {
      const p = searchProductDocsInputSchema.parse(args);
      const freeformQuery = p.freeformQuery?.trim() ?? '';
      const q = (freeformQuery || [p.productName, p.topic, p.surfaceType].filter(Boolean).join(' ')).trim();
      const resolvedProductName = freeformQuery ? '' : (p.productName || '');
      /**
       * B0-479 — a `freeformQuery` call used to skip product-entity resolution entirely (this
       * passed `''`), so a query that names a product perfectly well (a bare SKU like `07512-00`,
       * an acronym, a short product name) never touched `rag.product_alias` and instead fell
       * through to `resolveProductLineFromMatches`'s post-hoc similarity lock over an unfiltered
       * search — which is how a Kling SKU query ended up served another product line's SDS as a
       * cited source. Freeform text now gets a resolution attempt too, but in `mode: 'freeform'`
       * (exact + tokenized alias tiers only, no verified-tiebreak; see
       * `~/lib/rag/entity-context.ts`), so an unambiguous alias hit anchors retrieval while a
       * natural-language question or a name spanning several product lines still resolves to
       * nothing and behaves exactly as before.
       */
      const [{ productLineKey, productKey, resolutionSource, aliasResolution }, sectionType] = await Promise.all([
        freeformQuery
          ? resolveProductEntityWithAliasTelemetry(freeformQuery, name, auditCtx, {
              mode: 'freeform',
            })
          : resolveProductEntityWithAliasTelemetry(resolvedProductName, name, auditCtx),
        Promise.resolve(inferSectionTypeFromQuery(q)),
      ]);
      const intent = classifyRetrievalIntent(q, resolvedProductName);
      const result = await ragQueryForProductKnowledgeWithMeta({
        query: q,
        productLineKey,
        productKey,
        productLineKeySource: resolutionSource,
        sectionType,
        limit: intent.limit,
        maxPerDocument: intent.maxPerDocument,
        requiredDocumentKinds: intent.requiredDocumentKinds,
        excludeKnowledgeCategories: resolveKnowledgeCategoryExclusions(auditCtx?.specialistId, q),
      });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        aliasResolution,
        query: q,
        // B0-460 — read back by `buildModelToolPayload` (`~/lib/tools/model-tool-payload`) to decide
        // whether a `product_line_profile` source's "Size and package variants" section stays
        // collapsed for the model. Carried on the payload (not threaded through `executeToolCall`)
        // so the flag travels with the exact call that produced it.
        includeVariants: p.includeVariants,
        entityContextBlock: result.entityContextBlock,
        sources: sourcePayload(result),
        retrieval: result.retrieval,
      };
    }
    case 'get_product_spec': {
      const p = getProductSpecInputSchema.parse(args);
      const q = `${p.productId} specifications technical datasheet performance`;
      const { productLineKey, productKey, resolutionSource, aliasResolution } =
        await resolveProductEntityWithAliasTelemetry(p.productId, name, auditCtx);
      const result = await ragQueryForProductKnowledgeWithMeta({
        query: q,
        productLineKey,
        productKey,
        productLineKeySource: resolutionSource,
        sectionType: null,
        excludeKnowledgeCategories: resolveKnowledgeCategoryExclusions(auditCtx?.specialistId, q),
      });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        aliasResolution,
        productId: p.productId,
        entityContextBlock: result.entityContextBlock,
        sources: sourcePayload(result),
        retrieval: result.retrieval,
      };
    }
    case 'get_approved_usage_guidance': {
      const p = getApprovedUsageGuidanceInputSchema.parse(args);
      const { productLineKey, productKey, resolutionSource, aliasResolution } =
        await resolveProductEntityWithAliasTelemetry(p.productId, name, auditCtx);
      const sectionType = inferSectionTypeFromToolName('get_approved_usage_guidance');
      const result = await retrieveApprovedUsage({
        ...p,
        productLineKey,
        productKey,
        productLineKeySource: resolutionSource,
        sectionType,
        excludeKnowledgeCategories: resolveKnowledgeCategoryExclusions(
          auditCtx?.specialistId,
          `${p.productId} ${p.task} ${p.surfaceType} ${p.environment ?? ''}`,
        ),
      });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        aliasResolution,
        productId: p.productId,
        task: p.task,
        surfaceType: p.surfaceType,
        environment: p.environment ?? null,
        entityContextBlock: result.entityContextBlock,
        sources: sourcePayload(result),
        retrieval: result.retrieval,
      };
    }
    case 'get_safety_constraints': {
      const p = getSafetyConstraintsInputSchema.parse(args);
      const [{ productLineKey, productKey, resolutionSource, aliasResolution }, sectionType] = await Promise.all([
        resolveProductEntityWithAliasTelemetry(p.productId, name, auditCtx),
        Promise.resolve(
          inferSectionTypeFromQuery(`${p.productId} safety hazards PPE SDS precautions first aid`),
        ),
      ]);
      const result = await retrieveSafetyConstraints({
        ...p,
        productLineKey,
        productKey,
        productLineKeySource: resolutionSource,
        sectionType,
        excludeKnowledgeCategories: resolveKnowledgeCategoryExclusions(
          auditCtx?.specialistId,
          p.productId,
        ),
      });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        aliasResolution,
        productId: p.productId,
        entityContextBlock: result.entityContextBlock,
        sources: sourcePayload(result),
        retrieval: result.retrieval,
      };
    }
    case 'get_compatibility_rules': {
      const p = getCompatibilityRulesInputSchema.parse(args);
      const { productLineKey, productKey, resolutionSource, aliasResolution } =
        await resolveProductEntityWithAliasTelemetry(p.productId, name, auditCtx);
      const sectionType = inferSectionTypeFromToolName('get_compatibility_rules');
      const result = await retrieveCompatibility({
        ...p,
        productLineKey,
        productKey,
        productLineKeySource: resolutionSource,
        sectionType,
        excludeKnowledgeCategories: resolveKnowledgeCategoryExclusions(
          auditCtx?.specialistId,
          `${p.productId} ${p.surfaceType} ${p.materialType ?? ''}`,
        ),
      });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        aliasResolution,
        productId: p.productId,
        surfaceType: p.surfaceType,
        materialType: p.materialType ?? null,
        entityContextBlock: result.entityContextBlock,
        sources: sourcePayload(result),
        retrieval: result.retrieval,
      };
    }
    case 'list_allowed_surfaces': {
      const p = listAllowedSurfacesInputSchema.parse(args);
      const { productLineKey, productKey, resolutionSource, aliasResolution } =
        await resolveProductEntityWithAliasTelemetry(p.productId, name, auditCtx);
      const sectionType = inferSectionTypeFromToolName('list_allowed_surfaces');
      const result = await retrieveSurfacesLists({
        productId: p.productId,
        mode: 'allowed',
        productLineKey,
        productKey,
        productLineKeySource: resolutionSource,
        sectionType,
        excludeKnowledgeCategories: resolveKnowledgeCategoryExclusions(
          auditCtx?.specialistId,
          p.productId,
        ),
      });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        aliasResolution,
        productId: p.productId,
        entityContextBlock: result.entityContextBlock,
        sources: sourcePayload(result),
        retrieval: result.retrieval,
      };
    }
    case 'list_disallowed_uses': {
      const p = listDisallowedUsesInputSchema.parse(args);
      const { productLineKey, productKey, resolutionSource, aliasResolution } =
        await resolveProductEntityWithAliasTelemetry(p.productId, name, auditCtx);
      const sectionType = inferSectionTypeFromToolName('list_disallowed_uses');
      const result = await retrieveSurfacesLists({
        productId: p.productId,
        mode: 'disallowed',
        productLineKey,
        productKey,
        productLineKeySource: resolutionSource,
        sectionType,
        excludeKnowledgeCategories: resolveKnowledgeCategoryExclusions(
          auditCtx?.specialistId,
          p.productId,
        ),
      });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        aliasResolution,
        productId: p.productId,
        entityContextBlock: result.entityContextBlock,
        sources: sourcePayload(result),
        retrieval: result.retrieval,
      };
    }
    case 'get_escalation_policy': {
      const p = getEscalationPolicyInputSchema.parse(args);
      const policy = escalationForIssueType(p.issueType);
      return {
        ok: true,
        adapter: 'static_policy_v1',
        issueType: p.issueType,
        policy,
      };
    }
    case 'lookup_cross_reference': {
      const p = lookupCrossReferenceInputSchema.parse(args);
      // B0-322: shares its result with `recommend_cross_reference`'s step 1 when the model calls both
      // with the same brand/product in one turn (see legacy-lookup-cache for the TTL scoping).
      return lookupCrossReferenceDeduped(p);
    }
    case 'get_products_in_category': {
      const p = getProductsInCategoryInputSchema.parse(args);
      return getProductsInCategory(p);
    }
    case 'get_product_category': {
      const p = getProductCategoryInputSchema.parse(args);
      return getProductCategory(p);
    }
    case 'recommend_cross_reference': {
      const p = recommendCrossReferenceInputSchema.parse(args);
      const result = await runCrossReferenceRecommendation({
        competitorProduct: p.competitorProduct,
        competitorBrand: p.competitorBrand ?? null,
      });
      return {
        ok: true,
        adapter: 'cross_reference_recommendation_v1',
        source: result.source,
        answered: result.answered,
        status: result.status,
        overallConfidence: result.overallConfidence,
        thresholdUsed: result.thresholdUsed,
        declineReason: result.declineReason,
        candidates: result.candidates.slice(0, p.maxResults ?? 5),
        evidence: result.evidence,
        recommendationId: result.recommendationId,
      };
    }
    case 'find_products_by_category': {
      const p = findProductsByCategoryInputSchema.parse(args);
      const route = await routeCategoryQuery(p.query);
      if (route.path === 'semantic') {
        return {
          ok: true,
          adapter: 'category_router_v1',
          path: 'semantic',
          reason: route.reason,
          confidence: route.confidence,
          topCandidate: route.topCandidate,
          hint: 'No confident category match — use search_product_docs for this query.',
          latencyMs: route.latencyMs,
        };
      }
      const max = Math.min(p.maxResults ?? 25, 50);
      return {
        ok: true,
        adapter: 'category_router_v1',
        path: 'category',
        confidence: route.confidence,
        matchType: route.matchType,
        node: route.node,
        productCount: route.productCount,
        products: route.products.slice(0, max),
        candidates: route.candidates,
        latencyMs: route.latencyMs,
      };
    }
    case 'get_efficacy_data': {
      const p = getEfficacyDataInputSchema.parse(args);

      // B0-549: batch form — an explicit id list or a category collapses what would otherwise be
      // N sequential single-product calls into this one. `p.productId` is always `''` (never
      // undefined, per `normalizeProductRef`) when neither productId nor productName was sent, so
      // this only branches when the caller actually supplied `productIds`/`category`.
      if ((p.productIds && p.productIds.length > 0) || p.category?.trim()) {
        return executeBatchEfficacyData(p, name, auditCtx);
      }

      // Out of scope for B0-250: fact/efficacy lookups key on product_line_key only.
      const { productLineKey, productKey, aliasResolution } =
        await resolveProductEntityWithAliasTelemetry(p.productId, name, auditCtx);
      const [facts, labReport, fastDrawLookup] = await Promise.all([
        productLineKey ? fetchFactsForProductLineKey(productLineKey, p.organism) : Promise.resolve(null),
        productLineKey
          ? fetchCurrentEfficacyLabReport(productLineKey, p.organism)
          : Promise.resolve(null),
        // B0-636 — FastDraw-dispenser-specific dilution/yield, kept as a DISTINCT sibling field,
        // never merged into `facts`: for ~8/40 FastDraw SKUs it legitimately disagrees with
        // `facts.dilutionDisplay` because the two describe different dilution contexts (general use
        // vs. the FastDraw dispenser).
        fetchFastDrawDilution(productLineKey, productKey),
      ]);
      const fastDrawDilution = fastDrawLookup?.fastDrawDilution ?? null;

      if (!facts && !labReport) {
        return {
          ok: true,
          adapter: 'structured_facts_v1',
          aliasResolution,
          productId: p.productId,
          organism: p.organism ?? null,
          facts: null,
          fastDrawDilution,
          note: 'No verified dilution/efficacy data on file for this product. Do not estimate or infer a value — tell the user the data is not verified.',
          ...(fastDrawLookup ? { sources: [fastDrawDilutionSourceEntry(fastDrawLookup)] } : {}),
        };
      }

      // B0-196: surface the verified facts as a first-class grounded source so the
      // validator's evidence summary (built from sources[].documentBody) can cite the
      // kill claim. Without this, an efficacy-only answer carries zero evidence and the
      // validator rejects the draft (confidence 0, human review). Mirrors the synthetic
      // `verified-facts` source that sourcePayload() adds for the semantic-search tools.
      const factsBlock = facts
        ? buildFactsBlock(
            new Map([[facts.entityId, facts]]),
            new Map([[facts.entityId, p.productId]]),
          )
        : null;

      // B0-237/238: the lab-report corpus (document_kind='efficacy') is a real, citable
      // rag.document — use its actual id/title so the model can cite `[doc:uuid]` per the
      // standard convention (product-support-prompts.ts), with the lab + Project # +
      // S3 source baked into documentBody for a regulatorily defensible citation.
      const labReportBlock = labReport ? renderEfficacyLabReportCitation(labReport) : null;

      const sources = [
        ...(factsBlock
          ? [
              {
                documentId: VERIFIED_FACTS_SOURCE_ID,
                chunkId: VERIFIED_FACTS_SOURCE_ID,
                title: 'Verified Product Facts (structured)',
                snippet: factsBlock.slice(0, 900),
                documentBody: factsBlock,
                documentKind: 'facts',
                similarity: 1,
                confidence: 1,
              },
            ]
          : []),
        ...(labReport && labReportBlock
          ? [
              {
                documentId: labReport.documentId,
                chunkId: labReport.documentId,
                title: labReport.title,
                snippet: labReportBlock.slice(0, 900),
                documentBody: labReportBlock,
                documentKind: 'efficacy',
                similarity: 1,
                confidence: 1,
              },
            ]
          : []),
        // B0-636 — distinct citation from "Verified Product Facts (structured)" above, so the
        // model can tell the general-use dilution and the FastDraw-dispenser dilution apart.
        ...(fastDrawLookup ? [fastDrawDilutionSourceEntry(fastDrawLookup)] : []),
      ];

      return {
        ok: true,
        adapter: 'structured_facts_v1',
        aliasResolution,
        productId: p.productId,
        productLineKey,
        organism: p.organism ?? null,
        facts,
        labReport,
        fastDrawDilution,
        sources,
      };
    }
    /**
     * B0-529 — dispenser/proportioner setup and dilution-ratio PROCEDURE documents.
     *
     * Deliberately not a product-entity-anchored search: a dispenser guide is written per dispenser
     * family, not per product line, so `resolveProductEntityByName` would either miss or wrongly lock
     * retrieval to one product line. The product name is used only as query text.
     */
    case 'get_dispenser_asset': {
      const p = getDispenserAssetInputSchema.parse(args);
      const q = buildKnowledgeAssetQuery([
        p.dispenserModel,
        p.productName,
        p.topic,
        'dispenser dilution control proportioner metering tip setup calibration dilution ratio',
      ]);
      const result = await retrieveKnowledgeAssets({ query: q, limit: p.maxResults });
      return {
        ok: true,
        adapter: KNOWLEDGE_ASSET_ADAPTER_TAG,
        query: result.query,
        scope: result.scope,
        dispenserModel: p.dispenserModel ?? null,
        productName: p.productName ?? null,
        topic: p.topic ?? null,
        sources: result.sources,
        retrieval: result.retrieval,
      };
    }
    /** B0-529 — coat-count / coverage charts and floor procedure bulletins. Same rationale as above. */
    case 'get_floor_asset': {
      const p = getFloorAssetInputSchema.parse(args);
      const q = buildKnowledgeAssetQuery([
        p.surfaceType,
        p.productName,
        p.procedure,
        'floor finish coats coverage yield recoat top scrub stripping procedure',
      ]);
      const result = await retrieveKnowledgeAssets({
        query: q,
        limit: p.maxResults,
        excludeKnowledgeCategories: resolveKnowledgeCategoryExclusions(auditCtx?.specialistId, q),
      });
      return {
        ok: true,
        adapter: KNOWLEDGE_ASSET_ADAPTER_TAG,
        query: result.query,
        scope: result.scope,
        surfaceType: p.surfaceType ?? null,
        productName: p.productName ?? null,
        procedure: p.procedure ?? null,
        sources: result.sources,
        retrieval: result.retrieval,
      };
    }
  }
}
