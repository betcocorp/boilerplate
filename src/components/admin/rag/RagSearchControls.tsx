'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { RagSearchSettingsDrawer } from '~/components/admin/rag/RagSearchSettingsDrawer';
import { RagSearchToolbar } from '~/components/admin/rag/RagSearchToolbar';
import { logSearchSubmit } from '~/lib/event-logging/search-events';

/** Drawer-editable retrieval settings. Mirrors the query-string fields `page.tsx` parses. */
export type RagSearchSettingsValues = {
  scope: string;
  retrieval: 'hybrid' | 'vector';
  limit: string;
  minSimilarity: string;
  sectionType: string;
  productLineKey: string;
  useReranker: boolean;
  useMultiIntent: boolean;
};

export const RAG_SEARCH_DEFAULT_SETTINGS: RagSearchSettingsValues = {
  scope: 'all',
  retrieval: 'hybrid',
  limit: '8',
  minSimilarity: '',
  sectionType: '',
  productLineKey: '',
  useReranker: false,
  useMultiIntent: false,
};

/** B0-761 — stable analytics surface id for the RAG semantic-search page. */
const RAG_SEARCH_SURFACE = 'rag-search';

type QueryOption = {
  query: string;
  queryCount: number;
};

type RagSearchControlsProps = {
  formAction: string;
  query: string;
  popularQueries: QueryOption[];
  initialSettings: RagSearchSettingsValues;
  /** Matches rendered for the current query, or `null` when no search ran. */
  resultCount: number | null;
  sectionTypeOptions: string[];
};

function countChangedSettings(settings: RagSearchSettingsValues) {
  let count = 0;

  if (settings.scope !== RAG_SEARCH_DEFAULT_SETTINGS.scope) count += 1;
  if (settings.retrieval !== RAG_SEARCH_DEFAULT_SETTINGS.retrieval) count += 1;
  if (settings.limit.trim() !== RAG_SEARCH_DEFAULT_SETTINGS.limit) count += 1;
  if (settings.minSimilarity.trim() !== RAG_SEARCH_DEFAULT_SETTINGS.minSimilarity) count += 1;
  if (settings.sectionType !== RAG_SEARCH_DEFAULT_SETTINGS.sectionType) count += 1;
  if (settings.productLineKey.trim() !== RAG_SEARCH_DEFAULT_SETTINGS.productLineKey) count += 1;
  if (settings.useReranker !== RAG_SEARCH_DEFAULT_SETTINGS.useReranker) count += 1;
  if (settings.useMultiIntent !== RAG_SEARCH_DEFAULT_SETTINGS.useMultiIntent) count += 1;

  return count;
}

/**
 * B0-621 — owns the shared toolbar + drawer settings state and the single `<form>` both render
 * into. Submission (Search button or the drawer's "Apply and re-run") builds a `URLSearchParams`
 * from `new FormData(formRef.current)` — the same pattern `RagQueryAutocomplete` already uses for
 * its own suggestion-select navigation — and pushes it as the new query string. Unchecked
 * checkboxes are naturally omitted by `FormData`, preserving the existing "absent = inherit
 * setting" semantics `parseExplicitTrue` relies on server-side.
 */
export function RagSearchControls({
  formAction,
  query,
  popularQueries,
  initialSettings,
  resultCount,
  sectionTypeOptions,
}: RagSearchControlsProps) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement | null>(null);
  const [settings, setSettings] = useState<RagSearchSettingsValues>(initialSettings);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const loggedSearchRef = useRef<string | null>(null);

  const changedCount = useMemo(() => countChangedSettings(settings), [settings]);

  // B0-761 — the search itself runs server-side from the query string, so the submit event is
  // emitted once the rendered results are known. Query length only; the query text is never logged.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || resultCount === null) {
      return;
    }

    const key = `${trimmed}|${resultCount}`;
    if (loggedSearchRef.current === key) {
      return;
    }
    loggedSearchRef.current = key;

    logSearchSubmit({
      entityType: 'chunk',
      resultCount,
      queryLength: trimmed.length,
      surface: RAG_SEARCH_SURFACE,
      extra: {
        retrieval: initialSettings.retrieval,
        scope: initialSettings.scope,
        useReranker: initialSettings.useReranker,
        useMultiIntent: initialSettings.useMultiIntent,
      },
    });
  }, [
    query,
    resultCount,
    initialSettings.retrieval,
    initialSettings.scope,
    initialSettings.useReranker,
    initialSettings.useMultiIntent,
  ]);

  function navigate() {
    const form = formRef.current;
    if (!form) {
      return;
    }

    const formData = new FormData(form);
    const params = new URLSearchParams();

    for (const [key, value] of formData.entries()) {
      if (typeof value === 'string') {
        params.set(key, value);
      }
    }

    const queryString = params.toString();
    router.push(queryString ? `${formAction}?${queryString}` : formAction);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate();
  }

  function patchSettings(patch: Partial<RagSearchSettingsValues>) {
    setSettings((current) => ({ ...current, ...patch }));
  }

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4"
      method="get"
      onSubmit={handleSubmit}
      ref={formRef}
    >
      <RagSearchToolbar
        changedCount={changedCount}
        onOpenDrawer={() => setDrawerOpen(true)}
        popularQueries={popularQueries}
        query={query}
        settings={settings}
      />
      <RagSearchSettingsDrawer
        onApply={() => setDrawerOpen(false)}
        onChange={patchSettings}
        onClose={() => setDrawerOpen(false)}
        onReset={() => setSettings(RAG_SEARCH_DEFAULT_SETTINGS)}
        open={drawerOpen}
        sectionTypeOptions={sectionTypeOptions}
        settings={settings}
      />
    </form>
  );
}
