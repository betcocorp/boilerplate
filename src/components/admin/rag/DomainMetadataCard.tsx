'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import {
  saveDomainMetadataAction,
  type SaveDomainMetadataState,
} from '~/lib/rag/corpus-config-actions';
import type { EnrichmentDocument } from '~/lib/rag/corpus-stats';

function DocumentMetadataRow({ doc }: { doc: EnrichmentDocument }) {
  const [state, dispatch, isPending] = useActionState<SaveDomainMetadataState, FormData>(
    saveDomainMetadataAction,
    null,
  );

  const saved = state?.ok === true && state.documentId === doc.id;
  const failed = state?.ok === false && state.documentId === doc.id;

  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-3 pr-4">
        <p className="text-sm font-medium text-slate-800">{doc.title}</p>
        <p className="mt-0.5 font-mono text-[11px] text-slate-400">{doc.documentKey}</p>
      </td>
      <td className="py-3 pr-4">
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
          {doc.documentKind}
        </span>
      </td>
      <td className="py-3 pr-3">
        <form action={dispatch} id={`meta-form-${doc.id}`}>
          <input name="documentId" type="hidden" value={doc.id} />
          <input
            className="h-8 w-full min-w-[140px] rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-500"
            defaultValue={doc.surfaceType}
            list="surface-type-suggestions"
            name="surfaceType"
            placeholder="e.g. Hard floor"
          />
        </form>
      </td>
      <td className="py-3 pr-3">
        <input
          className="h-8 w-20 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-500"
          defaultValue={doc.dwellTimeMinutes}
          form={`meta-form-${doc.id}`}
          min={0}
          name="dwellTimeMinutes"
          placeholder="e.g. 5"
          type="number"
        />
      </td>
      <td className="py-3 pr-3">
        <input
          className="h-8 w-24 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-500"
          defaultValue={doc.dilutionRatio}
          form={`meta-form-${doc.id}`}
          name="dilutionRatio"
          placeholder="e.g. 1:32"
        />
      </td>
      <td className="py-3">
        <div className="flex items-center gap-2">
          <button
            className="flex h-8 items-center gap-1.5 rounded-lg bg-violet-600 px-3 text-xs font-medium text-white transition hover:bg-violet-700 disabled:opacity-50"
            disabled={isPending}
            form={`meta-form-${doc.id}`}
            type="submit"
          >
            {isPending ? (
              <>
                <span className="inline-block size-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Saving
              </>
            ) : (
              'Save'
            )}
          </button>
          {saved ? (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
              Saved
            </span>
          ) : null}
          {failed ? (
            <span
              className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700"
              title={state?.error ?? 'Error'}
            >
              Error
            </span>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

type Props = {
  documents: EnrichmentDocument[];
  total: number;
  page: number;
  pageSize: number;
};

export function DomainMetadataCard({ documents, total, page, pageSize }: Props) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
            Improvement 3
          </p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
            Domain metadata enrichment
          </h2>
        </div>
        <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
          Active — writes to database
        </span>
      </div>
      <p className="mt-2 text-sm text-slate-500">
        These fields are stored in <code className="font-mono text-xs">document.metadata</code> JSONB
        today and will be used for similarity boosting once the RPC migration is applied.
      </p>

      {/* Datalist shared with ChunkingConfigCard if rendered on same page */}
      <datalist id="surface-type-suggestions">
        {[
          'Hard floor',
          'Carpet',
          'Restroom',
          'Glass',
          'Stainless steel',
          'Food contact surface',
        ].map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>

      {documents.length === 0 ? (
        <p className="mt-6 text-sm text-slate-400">No documents found.</p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-2xl border border-slate-200">
          <table className="w-full min-w-[700px] text-sm">
            <thead className="bg-slate-50">
              <tr>
                {['Document', 'Kind', 'Surface type', 'Dwell time (min)', 'Dilution ratio', ''].map(
                  (h) => (
                    <th
                      className="px-4 py-2.5 text-left text-xs font-semibold text-slate-600"
                      key={h}
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 px-4">
              {documents.map((doc) => (
                <DocumentMetadataRow doc={doc} key={doc.id} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      <div className="mt-4 flex items-center justify-between">
        <p className="text-xs text-slate-500">
          {total} document{total !== 1 ? 's' : ''} — page {page} of {totalPages}
        </p>
        <div className="flex gap-2">
          <Link
            aria-disabled={!hasPrev}
            className={`rounded-xl border px-3 py-1.5 text-xs font-medium transition ${
              hasPrev
                ? 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                : 'pointer-events-none border-transparent text-slate-300'
            }`}
            href={`?page=${page - 1}`}
          >
            Prev
          </Link>
          <Link
            aria-disabled={!hasNext}
            className={`rounded-xl border px-3 py-1.5 text-xs font-medium transition ${
              hasNext
                ? 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                : 'pointer-events-none border-transparent text-slate-300'
            }`}
            href={`?page=${page + 1}`}
          >
            Next
          </Link>
        </div>
      </div>
    </section>
  );
}
