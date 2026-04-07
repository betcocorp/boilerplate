/**
 * Shared bearer check for `/api/v1/*` machine endpoints.
 * Uses `V1_ORCHESTRATOR_API_KEY` (same secret as the orchestrator).
 */
export function isV1BearerAuthorized(request: Request): boolean {
  const configuredKey = process.env.V1_ORCHESTRATOR_API_KEY;

  if (!configuredKey) {
    return process.env.NODE_ENV !== 'production';
  }

  const authorizationHeader = request.headers.get('authorization');
  const bearerToken = authorizationHeader?.startsWith('Bearer ')
    ? authorizationHeader.slice('Bearer '.length)
    : null;

  return bearerToken === configuredKey;
}
