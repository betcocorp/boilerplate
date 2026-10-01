'use client';

/**
 * B0-333 — shared scrollable preview block for the single-run trace page.
 *
 * Matches the `JsonBlock` presentation already used by
 * `~/components/rag/RagDocumentChunkInspect`. Deliberately never truncates:
 * tool-call previews are already capped at 2000 / 4000 chars at write time by
 * `~/lib/audit/trace`, and step/audit payloads are shown whole.
 */
function toDisplayText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return '';
    }
    try {
      // Pretty-print when the preview is intact; truncated previews fall through
      // to the raw string rather than being altered.
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

export function TraceJsonBlock({
  value,
  label,
}: {
  value: unknown;
  label?: string;
}) {
  const text = toDisplayText(value);

  return (
    <div className="min-w-0 space-y-1">
      {label ? (
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </p>
      ) : null}
      {text ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border/80 bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
          {text}
        </pre>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      )}
    </div>
  );
}
