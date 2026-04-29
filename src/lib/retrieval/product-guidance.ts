import {
  ragQueryForProductKnowledgeWithMeta,
  type ProductKnowledgeQueryResult,
} from '~/lib/retrieval/product-knowledge';

function buildQuery(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

export async function retrieveApprovedUsage(input: {
  productId: string;
  task: string;
  surfaceType: string;
  environment?: string;
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
    skipProductLineResolution: true,
  });
}

export async function retrieveSafetyConstraints(input: {
  productId: string;
}): Promise<ProductKnowledgeQueryResult> {
  const q = buildQuery([
    input.productId,
    'safety hazards PPE SDS precautions first aid',
  ]);
  return ragQueryForProductKnowledgeWithMeta({
    query: q,
    skipProductLineResolution: true,
  });
}

export async function retrieveCompatibility(input: {
  productId: string;
  surfaceType: string;
  materialType?: string;
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
    skipProductLineResolution: true,
  });
}

export async function retrieveSurfacesLists(input: {
  productId: string;
  mode: 'allowed' | 'disallowed';
}): Promise<ProductKnowledgeQueryResult> {
  const hint =
    input.mode === 'allowed'
      ? 'approved surfaces substrates compatible'
      : 'do not use prohibited surfaces incompatible';
  const q = buildQuery([input.productId, hint]);
  return ragQueryForProductKnowledgeWithMeta({
    query: q,
    skipProductLineResolution: true,
  });
}
