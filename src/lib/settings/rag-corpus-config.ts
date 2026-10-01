/**
 * B0-686 — shape and bounds of the `RAG_CHUNK_*` / `RAG_BOOST_*` settings rows.
 *
 * Kept apart from `settings-service` (which pulls in the Supabase service-role client) so the
 * admin cards under `~/components/admin/rag` can import the same tuples and bounds they are
 * validated against without dragging a server-only client into the browser bundle.
 */

export const RAG_CHUNK_STRATEGIES = ['naive', 'heading-aware'] as const;

export type RagChunkStrategy = (typeof RAG_CHUNK_STRATEGIES)[number];

export const DEFAULT_RAG_CHUNK_STRATEGY: RagChunkStrategy = 'naive';

export type RagChunkingConfig = {
  strategy: RagChunkStrategy;
  minTokens: number;
  maxTokens: number;
  overlapTokens: number;
};

/** Bounds mirrored by the admin form and the save action so a stored value can't fall outside them. */
export const RAG_CHUNK_TOKEN_BOUNDS = {
  minTokens: { min: 50, max: 600, default: 300 },
  maxTokens: { min: 100, max: 2000, default: 600 },
  overlapTokens: { min: 0, max: 200, default: 50 },
} as const;

export type RagBoostConfig = {
  enabled: boolean;
  surfaceType: number;
  dwellTime: number;
  dilutionRatio: number;
};

/** Per-rule weight bounds, mirrored by the admin form and the save action. */
export const RAG_BOOST_WEIGHT_BOUNDS = { min: 0, max: 0.5 } as const;

export const DEFAULT_RAG_BOOST_WEIGHTS = {
  surfaceType: 0.1,
  dwellTime: 0.05,
  dilutionRatio: 0.05,
} as const;
