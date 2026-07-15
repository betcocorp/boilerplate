import {
  retrieveApprovedUsage,
  retrieveCompatibility,
  retrieveSafetyConstraints,
  retrieveSurfacesLists,
} from '~/lib/retrieval/product-guidance';
import { ragQueryForProductKnowledgeWithMeta } from '~/lib/retrieval/product-knowledge';
import { resolveProductLineKeyByName } from '~/lib/rag/entity-context';
import {
  inferSectionTypeFromQuery,
  inferSectionTypeFromToolName,
} from '~/lib/rag/section-type-inference';

import {
  findProductsByCategoryInputSchema,
  getApprovedUsageGuidanceInputSchema,
  getCompatibilityRulesInputSchema,
  getEscalationPolicyInputSchema,
  getProductCategoryInputSchema,
  getProductSpecInputSchema,
  getProductsInCategoryInputSchema,
  getSafetyConstraintsInputSchema,
  listAllowedSurfacesInputSchema,
  listDisallowedUsesInputSchema,
  lookupCrossReferenceInputSchema,
  searchProductDocsInputSchema,
  type ProductToolName,
} from '~/lib/tools/tool-schemas';
import { lookupCrossReference } from '~/lib/tools/cross-reference-lookup';
import { getProductCategory, getProductsInCategory } from '~/lib/tools/category-lookup';
import { routeCategoryQuery } from '~/lib/category/category-router';

const ADAPTER_TAG = 'rag_corpus_full_document' as const;

/**
 * Each "source" is a full document (assembled from all its chunks). The model is
 * expected to read `documentBody` for grounding and use `snippet` only as a
 * preview / citation hint.
 */
function sourcePayload(
  sources: Awaited<ReturnType<typeof ragQueryForProductKnowledgeWithMeta>>['sources'],
) {
  return sources.map((s) => ({
    documentId: s.documentId,
    chunkId: s.chunkId,
    title: s.title,
    snippet: s.snippet,
    documentBody: s.documentBody,
    documentBodyChars: s.documentBodyChars,
    documentBodyChunkCount: s.documentBodyChunkCount,
    documentBodyTruncated: s.documentBodyTruncated,
    documentBodyTokenEstimate: s.documentBodyTokenEstimate,
    matchedChunkText: s.matchedChunkText,
    confidence: s.similarity,
    documentKind: s.documentKind,
    productLineKey: s.productLineKey,
    freshness: null as null,
  }));
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

export async function executeProductTool(
  name: ProductToolName,
  args: unknown,
): Promise<Record<string, unknown>> {
  switch (name) {
    case 'search_product_docs': {
      const p = searchProductDocsInputSchema.parse(args);
      const q = (p.freeformQuery?.trim() || [p.productName, p.topic, p.surfaceType].filter(Boolean).join(' ')).trim();
      const resolvedProductName = p.freeformQuery?.trim() ? '' : (p.productName || '');
      const [productLineKey, sectionType] = await Promise.all([
        resolveProductLineKeyByName(resolvedProductName),
        Promise.resolve(inferSectionTypeFromQuery(q)),
      ]);
      const result = await ragQueryForProductKnowledgeWithMeta({
        query: q,
        productLineKey,
        sectionType,
      });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        query: q,
        entityContextBlock: result.entityContextBlock,
        sources: sourcePayload(result.sources),
        retrieval: result.retrieval,
      };
    }
    case 'get_product_spec': {
      const p = getProductSpecInputSchema.parse(args);
      const q = `${p.productId} specifications technical datasheet performance`;
      const productLineKey = await resolveProductLineKeyByName(p.productId);
      const result = await ragQueryForProductKnowledgeWithMeta({
        query: q,
        productLineKey,
        sectionType: null,
      });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        productId: p.productId,
        entityContextBlock: result.entityContextBlock,
        sources: sourcePayload(result.sources),
        retrieval: result.retrieval,
      };
    }
    case 'get_approved_usage_guidance': {
      const p = getApprovedUsageGuidanceInputSchema.parse(args);
      const productLineKey = await resolveProductLineKeyByName(p.productId);
      const sectionType = inferSectionTypeFromToolName('get_approved_usage_guidance');
      const result = await retrieveApprovedUsage({ ...p, productLineKey, sectionType });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        productId: p.productId,
        task: p.task,
        surfaceType: p.surfaceType,
        environment: p.environment ?? null,
        entityContextBlock: result.entityContextBlock,
        sources: sourcePayload(result.sources),
        retrieval: result.retrieval,
      };
    }
    case 'get_safety_constraints': {
      const p = getSafetyConstraintsInputSchema.parse(args);
      const [productLineKey, sectionType] = await Promise.all([
        resolveProductLineKeyByName(p.productId),
        Promise.resolve(
          inferSectionTypeFromQuery(`${p.productId} safety hazards PPE SDS precautions first aid`),
        ),
      ]);
      const result = await retrieveSafetyConstraints({ ...p, productLineKey, sectionType });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        productId: p.productId,
        entityContextBlock: result.entityContextBlock,
        sources: sourcePayload(result.sources),
        retrieval: result.retrieval,
      };
    }
    case 'get_compatibility_rules': {
      const p = getCompatibilityRulesInputSchema.parse(args);
      const productLineKey = await resolveProductLineKeyByName(p.productId);
      const sectionType = inferSectionTypeFromToolName('get_compatibility_rules');
      const result = await retrieveCompatibility({ ...p, productLineKey, sectionType });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        productId: p.productId,
        surfaceType: p.surfaceType,
        materialType: p.materialType ?? null,
        entityContextBlock: result.entityContextBlock,
        sources: sourcePayload(result.sources),
        retrieval: result.retrieval,
      };
    }
    case 'list_allowed_surfaces': {
      const p = listAllowedSurfacesInputSchema.parse(args);
      const productLineKey = await resolveProductLineKeyByName(p.productId);
      const sectionType = inferSectionTypeFromToolName('list_allowed_surfaces');
      const result = await retrieveSurfacesLists({
        productId: p.productId,
        mode: 'allowed',
        productLineKey,
        sectionType,
      });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        productId: p.productId,
        entityContextBlock: result.entityContextBlock,
        sources: sourcePayload(result.sources),
        retrieval: result.retrieval,
      };
    }
    case 'list_disallowed_uses': {
      const p = listDisallowedUsesInputSchema.parse(args);
      const productLineKey = await resolveProductLineKeyByName(p.productId);
      const sectionType = inferSectionTypeFromToolName('list_disallowed_uses');
      const result = await retrieveSurfacesLists({
        productId: p.productId,
        mode: 'disallowed',
        productLineKey,
        sectionType,
      });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        productId: p.productId,
        entityContextBlock: result.entityContextBlock,
        sources: sourcePayload(result.sources),
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
      return lookupCrossReference(p);
    }
    case 'get_products_in_category': {
      const p = getProductsInCategoryInputSchema.parse(args);
      return getProductsInCategory(p);
    }
    case 'get_product_category': {
      const p = getProductCategoryInputSchema.parse(args);
      return getProductCategory(p);
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
  }
}
