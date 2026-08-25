import type { RoutingTestAccuracyTone } from './scoring';

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

/**
 * B0-670 — Tailwind text-color class for each `routingTestAccuracyTone` result, matching the
 * emerald/red pass-fail palette other admin pages already use for accuracy figures (e.g.
 * `RoutingAccuracyBoard.tsx`, `admin/tests/[testId]/page.tsx`). `neutral` is the plain slate color
 * both render sites already used before this ticket, kept explicit here so switching tones never
 * leaves the text without a color class.
 */
export const ROUTING_TEST_ACCURACY_TONE_CLASSES: Record<RoutingTestAccuracyTone, string> = {
  good: 'text-emerald-700',
  neutral: 'text-slate-900',
  bad: 'text-red-700',
};
