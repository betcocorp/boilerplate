import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Normalises a string for near-duplicate detection: trim, collapse whitespace, lowercase. */
export function normalizeForDedupe(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Extracts a message string from an unknown thrown value.
 * When `fallback` is omitted, non-Error values are coerced via `String()`.
 */
export function getErrorMessage(err: unknown, fallback?: string): string {
  return err instanceof Error ? err.message : (fallback ?? String(err));
}

/**
 * Retries an async operation up to `attempts` times with exponential back-off.
 * Every failure below the attempt cap is swallowed; the last failure propagates.
 */
export async function withRetry<T>(
  fn: () => PromiseLike<T>,
  options: { attempts?: number; initialDelayMs?: number } = {},
): Promise<T> {
  const { attempts = 3, initialDelayMs = 1500 } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, initialDelayMs * 2 ** (attempt - 1)),
        );
      }
    }
  }

  throw lastError;
}

/**
 * Asserts that a Supabase query result has no error, throwing if one is present.
 * Returns the `data` field on success.
 */
export function assertSupabaseNoError<T>(payload: {
  data: T;
  error: { message: string } | null;
}): T {
  if (payload.error) {
    throw new Error(payload.error.message);
  }
  return payload.data;
}
