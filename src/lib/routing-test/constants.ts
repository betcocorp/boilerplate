/**
 * Shared routing-test constants. Kept out of `./actions.ts` because a `'use server'` module may
 * only export async functions.
 */
export const ROUTING_TEST_PATH = '/admin/routing-test';

/** Labels for the router-type select (B0-659/B0-666). */
export const ROUTING_TEST_ROUTER_LABELS = {
  keyword: 'Keyword',
  semantic: 'Semantic',
  llm: 'LLM',
} as const;
