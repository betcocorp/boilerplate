import type { SmeAgentId } from '~/lib/agents/agent-registry';
import rawSemanticRouterEmbeddings from '~/lib/orchestrator/semantic-router-embeddings.json';

/**
 * B0-680 — thin indirection around the static `semantic-router-embeddings.json` import.
 *
 * Isolated into its own module (rather than imported directly by `semantic-router.ts`) purely for
 * testability: `semantic-router.test.ts` mocks THIS module the same way it mocks
 * `semantic-router-config.ts` and `~/lib/settings/settings-service`, so the loader/validator logic
 * in `semantic-router.ts` can be exercised against a synthetic corpus without depending on the real
 * OpenAI-computed vectors being present. Production code gets the real file exactly as if it had
 * imported the JSON directly — this module adds no behavior of its own.
 */

/** Shape of `semantic-router-embeddings.json`, produced by `scripts/generate-semantic-router-embeddings.ts`. */
export type SemanticRouterEmbeddingsFile = {
  format: number;
  examplesVersion: string;
  embeddingModel: string;
  dimensions: number;
  generatedAt: string;
  routes: Partial<Record<SmeAgentId, { examples: string[]; vectors: number[][] }>>;
};

// Typed structurally by TS (`resolveJsonModule`) rather than trusted as `SemanticRouterEmbeddingsFile`
// outright — `semantic-router.ts` validates the shape/content at runtime before using any of it.
export const semanticRouterEmbeddingsFile: SemanticRouterEmbeddingsFile = rawSemanticRouterEmbeddings;
