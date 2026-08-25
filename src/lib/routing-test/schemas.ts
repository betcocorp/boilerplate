import { z } from 'zod';

import { SME_AGENT_IDS } from '~/lib/agents/agent-registry';

/**
 * B0-657 — the expected-agent enum, derived from `SME_AGENT_IDS` so the TS side can never drift
 * from the registry.
 *
 * KEEP IN SYNC: `public.routing_test_items.expected_agent` carries the same five values in a DB
 * CHECK constraint (`routing_test_items_expected_agent_check`). Postgres cannot import this
 * constant, so adding a sixth SME agent means a new migration that alters that constraint as well
 * — this schema picks the new id up automatically, the database will not.
 */
export const routingTestExpectedAgentSchema = z.enum(SME_AGENT_IDS);

/** Mirrors the `ROUTER_TYPE` setting's allowed values. */
export const routingTestRouterTypeSchema = z.enum(['keyword', 'semantic']);

const promptSchema = z
  .string()
  .trim()
  .min(1, 'Enter a prompt before saving.')
  .max(4000, 'Prompt is too long (4000 characters max).');

/** Create payload, post-trim. */
export const routingTestItemCreateSchema = z.object({
  prompt: promptSchema,
  expectedAgent: routingTestExpectedAgentSchema,
});

/** Update payload — same fields plus the row id. */
export const routingTestItemUpdateSchema = routingTestItemCreateSchema.extend({
  id: z.string().uuid('Missing or malformed item id.'),
});

export const routingTestItemDeleteSchema = z.object({
  id: z.string().uuid('Missing or malformed item id.'),
});

export type RoutingTestItemCreateInput = z.infer<
  typeof routingTestItemCreateSchema
>;
export type RoutingTestItemUpdateInput = z.infer<
  typeof routingTestItemUpdateSchema
>;

/**
 * First Zod issue as a single human-readable line — the routing-test actions surface errors as a
 * `?error=` toast, not a field-level form state, so only the leading message is useful.
 */
export function firstIssueMessage(
  error: z.ZodError,
  fallback = 'Invalid input.',
): string {
  return error.issues[0]?.message ?? fallback;
}
