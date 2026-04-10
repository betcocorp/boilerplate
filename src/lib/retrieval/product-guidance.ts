import { ragQueryForProductKnowledge, type CuratedSource } from '~/lib/retrieval/product-knowledge';

function buildQuery(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

export async function retrieveApprovedUsage(input: {
  productId: string;
  task: string;
  surfaceType: string;
  environment?: string;
}): Promise<CuratedSource[]> {
  const q = buildQuery([
    input.productId,
    input.task,
    input.surfaceType,
    input.environment,
    'approved use directions procedure',
  ]);
  return ragQueryForProductKnowledge({ query: q, limit: 6 });
}

export async function retrieveSafetyConstraints(input: {
  productId: string;
}): Promise<CuratedSource[]> {
  const q = buildQuery([
    input.productId,
    'safety hazards PPE SDS precautions first aid',
  ]);
  return ragQueryForProductKnowledge({ query: q, limit: 6 });
}

export async function retrieveCompatibility(input: {
  productId: string;
  surfaceType: string;
  materialType?: string;
}): Promise<CuratedSource[]> {
  const q = buildQuery([
    input.productId,
    'compatibility',
    input.surfaceType,
    input.materialType,
    'safe for surfaces materials',
  ]);
  return ragQueryForProductKnowledge({ query: q, limit: 6 });
}

export async function retrieveSurfacesLists(input: {
  productId: string;
  mode: 'allowed' | 'disallowed';
}): Promise<CuratedSource[]> {
  const hint =
    input.mode === 'allowed'
      ? 'approved surfaces substrates compatible'
      : 'do not use prohibited surfaces incompatible';
  const q = buildQuery([input.productId, hint]);
  return ragQueryForProductKnowledge({ query: q, limit: 6 });
}
