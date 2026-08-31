import { z } from 'zod';

import type { Tables } from '~/types/supabase.public';

/**
 * Row shape for `public.event_logging` (app-facing types).
 *
 * `sentry` and `meta` are `jsonb` columns; the generated `Json` union is narrowed here
 * to the object form every writer and reader actually uses.
 */
export type EventLogging = Omit<Tables<'event_logging'>, 'sentry' | 'meta'> & {
  sentry: Record<string, unknown>;
  meta: Record<string, unknown>;
};

/** A JSON object (never an array or a primitive) — the shape both jsonb columns accept. */
const jsonObjectSchema = z.record(z.string(), z.unknown());

/** Request contract for `POST /api/events/log`. */
export const eventLogRequestBodySchema = z.object({
  event: z.string().trim().min(1).max(512),
  sentry: jsonObjectSchema.default({}),
  meta: jsonObjectSchema.default({}),
});

export type EventLogRequestBody = z.infer<typeof eventLogRequestBodySchema>;

/** Shape returned by `POST /api/events/log` after a successful insert. */
export type EventLogResult = Pick<EventLogging, 'id' | 'event' | 'created_at'>;
