/**
 * Base path every permissions editor mutates through (B0-410, pairs with B0-409).
 *
 * c360's components fetched `/api/proxy/permissions/...` — an unauthenticated catch-all proxy in
 * front of the Express API. this app has no proxy: the handlers under
 * `src/app/api/admin/permissions/**` authenticate the browser session and check
 * `admin.card.permissions` themselves. The sub-paths and request bodies are otherwise unchanged,
 * so this constant is the whole of the rewrite.
 */
export const PERMISSIONS_API_BASE = '/api/admin/permissions';

/**
 * `response.json()` without letting a non-JSON body (a proxy error page, an empty 500) throw on top
 * of the failure the caller is already handling.
 */
export async function readJsonEnvelope(
  response: Response,
): Promise<{ success?: boolean; error?: string; message?: string } & Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The message to show for a failed mutation: the handler's own text, else `fallback`. */
export function envelopeErrorMessage(
  envelope: { error?: unknown; message?: unknown },
  fallback: string,
): string {
  if (typeof envelope.error === 'string' && envelope.error.trim()) {
    return envelope.error;
  }
  if (typeof envelope.message === 'string' && envelope.message.trim()) {
    return envelope.message;
  }
  return fallback;
}
