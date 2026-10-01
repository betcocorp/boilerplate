/**
 * Shared bearer check for RAG sync/search endpoints.
 * Uses `RAG_SYNC_API_KEY`.
 */
export function isRagSyncAuthorized(request: Request): boolean {
  const configuredKey = process.env.RAG_SYNC_API_KEY;

  if (!configuredKey) {
    return process.env.NODE_ENV !== 'production';
  }

  const authorizationHeader = request.headers.get('authorization');
  const bearerToken = authorizationHeader?.startsWith('Bearer ')
    ? authorizationHeader.slice('Bearer '.length)
    : null;

  return bearerToken === configuredKey;
}
