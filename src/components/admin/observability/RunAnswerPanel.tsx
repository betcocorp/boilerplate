/**
 * B0-418 — the answer the run actually produced, rendered as markdown at the top of
 * the trace page.
 *
 * Before this, `final_output.answerText` existed only inside the collapsed
 * `workflow_completed` JSON detail, so the answer under review could not be read
 * without expanding a blob. Reuses `BexStreamdown` — the same renderer the Bex chat
 * uses for assistant messages — so an answer reads here exactly as it did in chat.
 */

import { BexStreamdown } from '~/components/bex/BexStreamdown';

type Props = {
  answerText: string | null;
  /** `final_output.error`: set instead of an answer when the run threw. */
  error: string | null;
};

export function RunAnswerPanel({ answerText, error }: Props) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-slate-900">Answer</h2>
        {answerText ? (
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium tabular-nums text-slate-500">
            {answerText.length.toLocaleString('en-US')} chars
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-destructive">
            Run error
          </p>
          <p className="mt-1.5 whitespace-pre-wrap break-words font-mono text-xs text-destructive">
            {error}
          </p>
          <p className="mt-2 text-xs text-destructive/80">
            This run recorded an error instead of an answer.
          </p>
        </div>
      ) : null}

      {answerText ? (
        <BexStreamdown
          className="mt-0 text-sm text-slate-800"
          content={answerText}
          isStreaming={false}
          isUser={false}
        />
      ) : null}

      {!answerText && !error ? (
        <p className="text-sm text-slate-400">
          n/a — no answer text recorded on this run.
        </p>
      ) : null}
    </section>
  );
}
