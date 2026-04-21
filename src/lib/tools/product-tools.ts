import {
  retrieveApprovedUsage,
  retrieveCompatibility,
  retrieveSafetyConstraints,
  retrieveSurfacesLists,
} from '~/lib/retrieval/product-guidance';
import {
  type CuratedSource,
  ragQueryForProductKnowledgeWithMeta,
} from '~/lib/retrieval/product-knowledge';

import {
  getApprovedUsageGuidanceInputSchema,
  getCompatibilityRulesInputSchema,
  getEscalationPolicyInputSchema,
  getProductSpecInputSchema,
  getSafetyConstraintsInputSchema,
  listAllowedSurfacesInputSchema,
  listDisallowedUsesInputSchema,
  lookupCrossReferenceInputSchema,
  searchProductDocsInputSchema,
  type ProductToolName,
} from '~/lib/tools/tool-schemas';
import { lookupCrossReference } from '~/lib/tools/cross-reference-lookup';

const ADAPTER_TAG = 'rag_corpus_transitional' as const;

function sourcePayload(
  sources: Awaited<ReturnType<typeof ragQueryForProductKnowledgeWithMeta>>['sources'],
) {
  return sources.map((s) => ({
    documentId: s.documentId,
    chunkId: s.chunkId,
    title: s.title,
    snippet: s.snippet,
    confidence: s.similarity,
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
      const q = [p.productName, p.topic, p.surfaceType]
        .filter(Boolean)
        .join(' ');
      const result = await ragQueryForProductKnowledgeWithMeta({ query: q, limit: 8 });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        query: q,
        sources: sourcePayload(result.sources),
        retrieval: result.retrieval,
      };
    }
    case 'get_product_spec': {
      const p = getProductSpecInputSchema.parse(args);
      const q = `${p.productId} specifications technical datasheet performance`;
      const result = await ragQueryForProductKnowledgeWithMeta({ query: q, limit: 6 });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        productId: p.productId,
        sources: sourcePayload(result.sources),
        retrieval: result.retrieval,
      };
    }
    case 'get_approved_usage_guidance': {
      const p = getApprovedUsageGuidanceInputSchema.parse(args);
      const result = await retrieveApprovedUsage(p);
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        productId: p.productId,
        task: p.task,
        surfaceType: p.surfaceType,
        environment: p.environment ?? null,
        sources: sourcePayload(result.sources),
        retrieval: result.retrieval,
      };
    }
    case 'get_safety_constraints': {
      const p = getSafetyConstraintsInputSchema.parse(args);
      const result = await retrieveSafetyConstraints(p);
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        productId: p.productId,
        sources: sourcePayload(result.sources),
        retrieval: result.retrieval,
      };
    }
    case 'get_compatibility_rules': {
      const p = getCompatibilityRulesInputSchema.parse(args);
      const result = await retrieveCompatibility(p);
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        productId: p.productId,
        surfaceType: p.surfaceType,
        materialType: p.materialType ?? null,
        sources: sourcePayload(result.sources),
        retrieval: result.retrieval,
      };
    }
    case 'list_allowed_surfaces': {
      const p = listAllowedSurfacesInputSchema.parse(args);
      const result = await retrieveSurfacesLists({
        productId: p.productId,
        mode: 'allowed',
      });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        productId: p.productId,
        sources: sourcePayload(result.sources),
        retrieval: result.retrieval,
      };
    }
    case 'list_disallowed_uses': {
      const p = listDisallowedUsesInputSchema.parse(args);
      const result = await retrieveSurfacesLists({
        productId: p.productId,
        mode: 'disallowed',
      });
      return {
        ok: true,
        adapter: ADAPTER_TAG,
        productId: p.productId,
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
  }
}
