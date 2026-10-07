/**
 * Shared message-cell layout for tables that display a per-item run result.
 *
 * Top block matches the former single-line cell: `errorMessage || responseText || 'n/a'`
 * (so failed rows show the evaluator's reason first). Below that, the stored
 * assistant body (`responseText`) so the LLM answer is always visible underneath.
 */
export function ResultItemMessageCell({
  errorMessage,
  responseText,
  draftAnswer,
}: {
  errorMessage: string | null;
  responseText: string | null;
  /** B0-349 — pre-validation draft; rendered only when present and it differs from `responseText`. */
  draftAnswer?: string | null;
}) {
  const assistant = responseText?.trim() ?? '';
  const legacyLine = errorMessage?.trim() || assistant || 'n/a';
  const draft = draftAnswer?.trim() ?? '';
  const showDraft = draft.length > 0 && draft !== assistant;

  return (
    <div className="flex flex-col gap-2">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Message
        </p>
        <p className="mt-1 whitespace-pre-wrap text-slate-700">{legacyLine}</p>
      </div>
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Assistant response
        </p>
        <p className="mt-1 whitespace-pre-wrap text-slate-800">
          {assistant || '—'}
        </p>
      </div>
      {showDraft ? (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Draft (pre-validation)
          </p>
          <p className="mt-1 whitespace-pre-wrap text-slate-800">{draft}</p>
        </div>
      ) : null}
    </div>
  );
}
