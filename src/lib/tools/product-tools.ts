import {
  retrieveApprovedUsage,
  retrieveCompatibility,
  retrieveSafetyConstraints,
  retrieveSurfacesLists,
} from '~/lib/retrieval/product-guidance';
import { ragQueryForProductKnowledgeWithMeta } from '~/lib/retrieval/product-knowledge';
import { buildFactsBlock, fetchFactsForProductLineKey } from '~/lib/retrieval/product-facts';
import {
  fetchCurrentEfficacyLabReport,
  renderEfficacyLabReportCitation,
} from '~/lib/retrieval/efficacy-lab-report';
import { VERIFIED_FACTS_SOURCE_ID } from '~/lib/rag/document-chunk-types';
import {
  resolveProductEntityByName,
  type ProductEntityResolutionResult,
} from '~/lib/rag/entity-context';
import {
  inferSectionTypeFromQuery,
  inferSectionTypeFromToolName,
} from '~/lib/rag/section-type-inference';
import { writeAuditLog, type AuditContext } from '~/lib/audit/audit-log';

import {
  findProductsByCategoryInputSchema,
  getApprovedUsageGuidanceInputSchema,
  getCompatibilityRulesInputSchema,
  getEfficacyDataInputSchema,
  getEscalationPolicyInputSchema,
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
};

function classifyAliasResolutionOutcome(
  resolution: Pick<ProductEntityResolutionResult, 'resolutionSource' | 'ambiguousAlias'>,
): AliasResolutionOutcome {
  if (resolution.resolutionSource === 'alias_exact') {
    return 'alias_exact';
  }
  if (resolution.resolutionSource === 'alias_fuzzy' || resolution.resolutionSource === 'alias_fuzzy_trgm') {
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
): Promise<ProductEntityResolutionResult & { aliasResolution: AliasResolutionTelemetry }> {
  const resolution = await resolveProductEntityByName(nameOrId);
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

  return { ...resolution, aliasResolution: { attempted, outcome } };
}

/**
 * Each "source" is a full document (assembled from all its chunks). The model is
 * expected to read `documentBody` for grounding and use `snippet` only as a
 * preview / citation hint.
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
    matchedChunkText: s.matchedChunkText,
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
      matchedChunkText: result.factsBlock,
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
 * B0-201: derive curation knobs from query intent. Single-product deep-dives get more facets
 * of one line; comparisons surface several distinct lines. Undefined fields = pipeline defaults.
 */
function classifyRetrievalIntent(
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
  return {};
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
      const q = (p.freeformQuery?.trim() || [p.productName, p.topic, p.surfaceType].filter(Boolean).join(' ')).trim();
      const resolvedProductName = p.freeformQuery?.trim() ? '' : (p.productName || '');
      const [{ productLineKey, productKey, resolutionSource, aliasResolution }, sectionType] = await Promise.all([
        resolveProductEntityWithAliasTelemetry(resolvedProductName, name, auditCtx),
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
      // Out of scope for B0-250: fact/efficacy lookups key on product_line_key only.
      const { productLineKey, aliasResolution } = await resolveProductEntityWithAliasTelemetry(
        p.productId,
        name,
        auditCtx,
      );
      const [facts, labReport] = productLineKey
        ? await Promise.all([
            fetchFactsForProductLineKey(productLineKey, p.organism),
            fetchCurrentEfficacyLabReport(productLineKey, p.organism),
          ])
        : [null, null];

      if (!facts && !labReport) {
        return {
          ok: true,
          adapter: 'structured_facts_v1',
          aliasResolution,
          productId: p.productId,
          organism: p.organism ?? null,
          facts: null,
          note: 'No verified dilution/efficacy data on file for this product. Do not estimate or infer a value — tell the user the data is not verified.',
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
                confidence: 1,
              },
            ]
          : []),
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
        sources,
      };
    }
  }
}
