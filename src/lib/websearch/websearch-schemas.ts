import { z } from 'zod';

/** Search depth — maps to the provider's basic/advanced modes. */
export const webSearchDepthSchema = z.enum(['basic', 'advanced']);
export type WebSearchDepth = z.infer<typeof webSearchDepthSchema>;

/** Request contract (client → /api/admin/web-search → WebSearchService). */
export const webSearchRequestSchema = z.object({
  query: z.string().min(1).max(2000),
  depth: webSearchDepthSchema.optional(),
  domains: z.array(z.string().min(1).max(253)).max(50).optional(),
  maxResults: z.number().int().min(1).max(20).optional(),
});
export type WebSearchRequest = z.infer<typeof webSearchRequestSchema>;

/** Bex-owned normalized result shape. No provider-specific fields leak past this. */
export const webSearchResultSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  snippet: z.string(),
  rawContent: z.string().optional(),
  score: z.number(),
  publishedAt: z.string().optional(),
});
export type WebSearchResult = z.infer<typeof webSearchResultSchema>;

export const webSearchMetricsSchema = z.object({
  latencyMs: z.number(),
  resultCount: z.number(),
  estimatedCostUsd: z.number(),
});
export type WebSearchMetrics = z.infer<typeof webSearchMetricsSchema>;

/** Response contract returned by the service + route. */
export const webSearchResponseSchema = z.object({
  query: z.string(),
  provider: z.string(),
  answer: z.string().nullable(),
  results: z.array(webSearchResultSchema),
  metrics: webSearchMetricsSchema,
});
export type WebSearchResponse = z.infer<typeof webSearchResponseSchema>;
