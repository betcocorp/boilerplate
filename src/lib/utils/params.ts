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
