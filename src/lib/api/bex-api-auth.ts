import { isV1BearerAuthorized } from '~/lib/api/v1-bearer-auth';

/**
 * Browser chat POST matches orchestrator: bearer OR non-empty message body.
 * Reads (conversation list / detail) are stricter in production when a V1 key is set;
 * set BEX_RELAX_CONVERSATION_READ=true for trusted admin deployments that cannot send a bearer from the browser.
 */
export function canPostBexChat(request: Request, body: unknown): boolean {
  if (isV1BearerAuthorized(request)) {
    return true;
  }

  if (
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    typeof (body as { message?: unknown }).message === 'string' &&
    (body as { message: string }).message.trim().length > 0
  ) {
    return true;
  }

  return false;
}

export function canReadBexConversations(request: Request): boolean {
  if (isV1BearerAuthorized(request)) {
    return true;
  }

  if (process.env.BEX_RELAX_CONVERSATION_READ === 'true') {
    return true;
  }

  if (!process.env.V1_ORCHESTRATOR_API_KEY) {
    return true;
  }

  return process.env.NODE_ENV !== 'production';
}
