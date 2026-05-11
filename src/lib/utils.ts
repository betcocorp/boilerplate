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
