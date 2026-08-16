import {
  ragQueryForProductKnowledgeWithMeta,
  type ProductKnowledgeQueryResult,
} from '~/lib/retrieval/product-knowledge';
import type { ProductEntityResolutionSource } from '~/lib/rag/entity-context';

function buildQuery(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

export async function retrieveApprovedUsage(input: {
  productId: string;
  task: string;
  surfaceType: string;
  environment?: string;
  productLineKey?: string | null;
  productKey?: string | null;
  /** B0-479: source of `productLineKey`, from `resolveProductEntityByName` — threaded through so retrieval telemetry can tag "alias-anchored" resolutions. */
  productLineKeySource?: ProductEntityResolutionSource;
  sectionType?: string | null;
}): Promise<ProductKnowledgeQueryResult> {
  const q = buildQuery([
    input.productId,
    input.task,
    input.surfaceType,
    input.environment,
    'approved use directions procedure',
  ]);
  return ragQueryForProductKnowledgeWithMeta({
    query: q,
    productLineKey: input.productLineKey,
    productKey: input.productKey,
    productLineKeySource: input.productLineKeySource,
    skipProductLineResolution: !input.productLineKey,
    sectionType: input.sectionType,
  });
}

export async function retrieveSafetyConstraints(input: {
  productId: string;
  productLineKey?: string | null;
  productKey?: string | null;
  productLineKeySource?: ProductEntityResolutionSource;
  sectionType?: string | null;
}): Promise<ProductKnowledgeQueryResult> {
  const q = buildQuery([
    input.productId,
    'safety hazards PPE SDS precautions first aid',
  ]);
  return ragQueryForProductKnowledgeWithMeta({
    query: q,
    productLineKey: input.productLineKey,
    productKey: input.productKey,
    productLineKeySource: input.productLineKeySource,
    skipProductLineResolution: !input.productLineKey,
    sectionType: input.sectionType,
  });
}

export async function retrieveCompatibility(input: {
  productId: string;
  surfaceType: string;
  materialType?: string;
  productLineKey?: string | null;
  productKey?: string | null;
  productLineKeySource?: ProductEntityResolutionSource;
  sectionType?: string | null;
}): Promise<ProductKnowledgeQueryResult> {
  const q = buildQuery([
    input.productId,
    'compatibility',
    input.surfaceType,
    input.materialType,
    'safe for surfaces materials',
  ]);
  return ragQueryForProductKnowledgeWithMeta({
    query: q,
    productLineKey: input.productLineKey,
    productKey: input.productKey,
    productLineKeySource: input.productLineKeySource,
    skipProductLineResolution: !input.productLineKey,
    sectionType: input.sectionType,
  });
}

export async function retrieveSurfacesLists(input: {
  productId: string;
  mode: 'allowed' | 'disallowed';
  productLineKey?: string | null;
  productKey?: string | null;
  productLineKeySource?: ProductEntityResolutionSource;
  sectionType?: string | null;
}): Promise<ProductKnowledgeQueryResult> {
  const hint =
    input.mode === 'allowed'
      ? 'approved surfaces substrates compatible'
      : 'do not use prohibited surfaces incompatible';
  const q = buildQuery([input.productId, hint]);
  return ragQueryForProductKnowledgeWithMeta({
    query: q,
    productLineKey: input.productLineKey,
    productKey: input.productKey,
    productLineKeySource: input.productLineKeySource,
    skipProductLineResolution: !input.productLineKey,
    sectionType: input.sectionType,
  });
}
