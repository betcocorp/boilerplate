/**
 * Clamps a number to a positive integer, returning `fallback` when the input
 * is not a finite number ≥ 1. Optionally caps at `max`.
 */
export function clampPositiveInteger(
  value: number | undefined,
  fallback: number,
  max?: number,
): number {
  if (!Number.isFinite(value) || !value || value < 1) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return max ? Math.min(normalized, max) : normalized;
}

/**
 * Coerces an unknown value to a positive integer, returning undefined when the
 * input is not a finite number ≥ 1 (e.g. strings, floats < 1, NaN, Infinity).
 */
export function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return undefined;
  }
  return Math.floor(value);
}

/**
 * Safely reads a single string value from a Next.js `searchParams` entry.
 * When the value is an array (multiple occurrences of the same key), the first
 * element is used. Falls back to `fallback` (default: `""`) when absent.
 */
export function readSearchParam(
  value: string | string[] | undefined,
  fallback = '',
): string {
  if (Array.isArray(value)) {
    return value[0] ?? fallback;
  }
  return value ?? fallback;
}
