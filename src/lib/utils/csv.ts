/**
 * Escapes a CSV cell value by wrapping in double-quotes when necessary
 * (i.e. when the value contains a comma, double-quote, or newline).
 */
export function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Sanitizes a string for use as a CSV download filename.
 * Replaces illegal filesystem characters with dashes and trims to 80 chars.
 */
export function sanitizeCsvFilename(name: string): string {
  const trimmed = name.trim() || 'export';
  return trimmed.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 80);
}
