import { createHash, randomBytes } from 'node:crypto';

/**
 * API token primitives for `/api/v1/*` client authentication.
 *
 * A token is `bex_{secret}` where the secret is 32 random bytes (base64url). Only the SHA-256 hash
 * is ever persisted; the full token is shown to the operator exactly once at creation. The short
 * `prefix` is stored alongside the hash so a token can be identified in the admin UI without
 * exposing the secret. (Environment was removed — it was never a bex-side boundary; any valid token
 * authenticates regardless of the consumer's environment.)
 */

const SECRET_BYTES = 32;
/** Characters of the full token retained for display (`bex_a1b2c3d4e`). */
const PREFIX_LENGTH = 13;

export interface GeneratedApiToken {
  /** Full secret — return to the operator once, never persist. */
  token: string;
  /** SHA-256 hex of `token` — this is what gets stored. */
  tokenHash: string;
  /** Leading slice of `token` for identification in the UI. */
  prefix: string;
}

export function generateApiToken(): GeneratedApiToken {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const token = `bex_${secret}`;

  return {
    token,
    tokenHash: hashApiToken(token),
    prefix: token.slice(0, PREFIX_LENGTH),
  };
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// Accepts current `bex_<secret>` tokens and legacy `bex_<env>_<secret>` tokens (underscores allowed).
const TOKEN_PATTERN = /^bex_[A-Za-z0-9_-]{16,}$/;

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
