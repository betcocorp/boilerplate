import { createHash, randomBytes } from 'node:crypto';

/**
 * API token primitives for `/api/v1/*` client authentication.
 *
 * A token is `bex_{env}_{secret}` where the secret is 32 random bytes
 * (base64url). Only the SHA-256 hash is ever persisted; the full token is
 * shown to the operator exactly once at creation. The short `prefix` is stored
 * alongside the hash so a token can be identified in the admin UI without
 * exposing the secret.
 */

export const API_ENVIRONMENTS = [
  'production',
  'staging',
  'development',
] as const;

export type ApiEnvironment = (typeof API_ENVIRONMENTS)[number];

/** Short, human-facing segment embedded in the token and its prefix. */
const ENVIRONMENT_SEGMENT: Record<ApiEnvironment, string> = {
  production: 'prod',
  staging: 'stg',
  development: 'dev',
};

const SECRET_BYTES = 32;
/** Characters of the full token retained for display (`bex_prod_a1b2`). */
const PREFIX_LENGTH = 13;

export interface GeneratedApiToken {
  /** Full secret — return to the operator once, never persist. */
  token: string;
  /** SHA-256 hex of `token` — this is what gets stored. */
  tokenHash: string;
  /** Leading slice of `token` for identification in the UI. */
  prefix: string;
}

export function environmentSegment(environment: ApiEnvironment): string {
  return ENVIRONMENT_SEGMENT[environment];
}

export function generateApiToken(environment: ApiEnvironment): GeneratedApiToken {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const token = `bex_${ENVIRONMENT_SEGMENT[environment]}_${secret}`;

  return {
    token,
    tokenHash: hashApiToken(token),
    prefix: token.slice(0, PREFIX_LENGTH),
  };
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const TOKEN_PATTERN = /^bex_(prod|stg|dev)_[A-Za-z0-9_-]{16,}$/;

/** Cheap shape check to reject obvious non-tokens before hashing/DB lookup. */
export function looksLikeApiToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

/** Extracts the bearer credential from an `Authorization: Bearer <token>` header. */
export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) {
    return null;
  }

  const separatorIndex = header.indexOf(' ');
  if (separatorIndex === -1) {
    return null;
  }

  const scheme = header.slice(0, separatorIndex);
  if (scheme.toLowerCase() !== 'bearer') {
    return null;
  }

  const token = header.slice(separatorIndex + 1).trim();
  return token.length > 0 ? token : null;
}
