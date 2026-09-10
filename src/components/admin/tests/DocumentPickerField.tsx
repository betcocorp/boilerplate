'use client';

import { ChevronDownIcon, Loader2Icon, XIcon } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '~/components/ui/button';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '~/components/ui/command';
import { Label } from '~/components/ui/label';
import {
  Popover,
  PopoverContent,
  popoverScrollInDialogProps,
  PopoverTrigger,
} from '~/components/ui/popover';

/** Row shape returned by `GET /api/admin/rag/document-search`. */
export type PickedDocument = {
  id: string;
  title: string;
  document_kind: string;
  language_code: string;
  is_current?: boolean;
};

/** Friendly names for the `rag.document.document_kind` values in the corpus. */
const DOCUMENT_KIND_LABELS: Record<string, string> = {
  label: 'Product Label',
  sds: 'SDS',
  tds: 'TDS',
  knowledge: 'Knowledge Base',
  product_line_profile: 'Product Profile',
  efficacy: 'Efficacy Study',
  fastdraw_dilution: 'FastDraw Dilution',
};

function kindLabel(kind: string): string {
  return DOCUMENT_KIND_LABELS[kind] ?? kind;
}

/** Below this the type-ahead stays idle — a one-character search is a table scan of nothing useful. */
const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 250;

type DocumentPickerFieldProps = {
  id: string;
  /** Form field name for the repeated hidden inputs — one per selected document id. */
  name: string;
  label: ReactNode;
  description?: ReactNode;
  placeholder?: string;
  /** `rag.document.id` uuids already stored on this row; resolved to titles on mount. */
  initialDocumentIds?: readonly string[];
};

/**
 * Multi-select type-ahead over `rag.document` (B0-934).
 *
 * `test_items.expected_sources` is a `uuid[]` of `rag.document.id`, so the visible badges show
 * document titles while the submitted payload stays uuids: one repeated hidden `<input>` per
 * selection. The hidden inputs are rendered from local state rather than being controlled fields
 * with a payload `value`, because React 19 resets uncontrolled form fields when a `<form action>`
 * succeeds.
 *
 * Neither `FilterableSuggestionField` nor `~/components/ui/labeled-combobox` fits here: both are
 * single-value pickers over a fully client-side option list. The corpus is ~5.9k documents, so the
 * options have to come from a debounced server search instead.
 */
export function DocumentPickerField({
  id,
  name,
  label,
  description,
  placeholder = 'Search Betco documents by product or title…',
  initialDocumentIds = [],
}: DocumentPickerFieldProps) {
  const initialIdsKey = initialDocumentIds.join(',');

  const [selected, setSelected] = useState<PickedDocument[]>(() =>
    initialDocumentIds.map((documentId) => ({
      id: documentId,
      title: '',
      document_kind: '',
      language_code: '',
    })),
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  /**
   * Results are stored with the term they answer, so "still searching" is derived from a mismatch
   * rather than tracked in a separate loading flag the effect would have to set synchronously.
   */
  const [search, setSearch] = useState<{
    query: string;
    documents: PickedDocument[];
    error: string | null;
  }>({ query: '', documents: [], error: null });

  /** Monotonic request id — a slower earlier search must never overwrite a newer result. */
  const searchSeq = useRef(0);

  // Hydrate the badges for an existing row: stored uuids → titles.
  useEffect(() => {
    const ids = initialIdsKey.split(',').filter((value) => value !== '');
    if (ids.length === 0) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(
          `/api/admin/rag/document-search?ids=${encodeURIComponent(ids.join(','))}`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as { documents?: PickedDocument[] };
        if (cancelled) {
          return;
        }
        const byId = new Map(
          (payload.documents ?? []).map((document) => [document.id, document]),
        );
        // Ids that no longer resolve keep their badge (and their hidden input) — dropping a stored
        // uuid silently on open would quietly edit the row's expectations.
        setSelected((current) =>
          current.map((document) => byId.get(document.id) ?? document),
        );
      } catch {
        // A failed hydrate leaves the uuid badges in place; nothing is lost on save.
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [initialIdsKey]);

  // Debounced server search with an out-of-order guard.
  useEffect(() => {
    const trimmed = query.trim();
    // Invalidating the sequence is enough to drop an in-flight response; no state is touched
    // synchronously in the effect body.
    const seq = (searchSeq.current += 1);
    if (trimmed.length < MIN_QUERY_LENGTH) {
      return;
    }

    const controller = new AbortController();

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(
            `/api/admin/rag/document-search?q=${encodeURIComponent(trimmed)}`,
            { signal: controller.signal },
          );
          if (seq !== searchSeq.current) {
            return;
          }
          if (!response.ok) {
            setSearch({
              query: trimmed,
              documents: [],
              error: 'Document search failed. Try again.',
            });
            return;
          }
          const payload = (await response.json()) as {
            documents?: PickedDocument[];
          };
          if (seq !== searchSeq.current) {
            return;
          }
          setSearch({
            query: trimmed,
            documents: payload.documents ?? [],
            error: null,
          });
        } catch {
          if (!controller.signal.aborted && seq === searchSeq.current) {
            setSearch({
              query: trimmed,
              documents: [],
              error: 'Document search failed. Try again.',
            });
          }
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const selectedIds = useMemo(
    () => new Set(selected.map((document) => document.id)),
    [selected],
  );

  const addDocument = (document: PickedDocument) => {
    setSelected((current) =>
      current.some((existing) => existing.id === document.id)
        ? current
        : [...current, document],
    );
  };

  const removeDocument = (documentId: string) => {
    setSelected((current) =>
      current.filter((document) => document.id !== documentId),
    );
  };

  const trimmedQuery = query.trim();
  const isTyping = trimmedQuery.length >= MIN_QUERY_LENGTH;
  /** True while the debounce timer or the request for the current term is still outstanding. */
  const isSearching = isTyping && search.query !== trimmedQuery;
  const results = isSearching ? [] : search.documents;
  const errorMessage = isSearching ? null : search.error;

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>

      <Popover
        modal={false}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (nextOpen) {
            setQuery('');
          }
        }}
        open={open}
      >
        <PopoverTrigger asChild>
          <Button
            aria-expanded={open}
            className="h-auto min-h-9 w-full justify-between rounded-3xl border border-transparent bg-input/50 px-3 py-2 font-normal whitespace-normal text-left text-muted-foreground hover:bg-input/60"
            id={id}
            role="combobox"
            type="button"
            variant="outline"
          >
            <span className="line-clamp-2">{placeholder}</span>
            <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="z-100 flex max-h-[min(22rem,calc(100vh-8rem))] w-[min(100vw-2rem,var(--radix-popover-trigger-width))] flex-col gap-0 overflow-hidden p-0"
          // B0-359: this picker renders inside the Add/Edit prompt dialog, whose scroll lock
          // would otherwise cancel every wheel event over the results list.
          {...popoverScrollInDialogProps}
        >
          <Command
            className="flex min-h-0 flex-1 flex-col overflow-hidden size-auto! **:data-[slot=command-input-wrapper]:shrink-0"
            label="Search documents"
            shouldFilter={false}
          >
            <CommandInput
              onValueChange={setQuery}
              placeholder="Type a product or document title…"
              value={query}
            />
            <CommandList className="max-h-[min(18rem,calc(100vh-12rem))] min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-py-1">
              {!isTyping ? (
                <p className="px-3 py-2 text-center text-xs text-muted-foreground">
                  Type at least {MIN_QUERY_LENGTH} characters to search labels, SDS
                  and knowledge-base documents.
                </p>
              ) : null}
              {isSearching ? (
                <p className="flex items-center justify-center gap-2 px-3 py-2 text-center text-xs text-muted-foreground">
                  <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
                  Searching…
                </p>
              ) : null}
              {isTyping && !isSearching && errorMessage ? (
                <p className="px-3 py-2 text-center text-xs text-destructive">
                  {errorMessage}
                </p>
              ) : null}
              {isTyping && !isSearching && !errorMessage && results.length === 0 ? (
                <p className="px-3 py-2 text-center text-xs text-muted-foreground">
                  No documents match that search.
                </p>
              ) : null}
              <CommandGroup>
                {results.map((document) => {
                  const alreadySelected = selectedIds.has(document.id);
                  return (
                    <CommandItem
                      key={document.id}
                      keywords={[document.title, document.document_kind]}
                      onSelect={() => addDocument(document)}
                      value={document.id}
                    >
                      <div className="flex min-w-0 flex-col gap-0.5 py-0.5">
                        <span className="font-medium">{document.title}</span>
                        <span className="text-xs text-muted-foreground">
                          {kindLabel(document.document_kind)}
                          {document.language_code
                            ? ` · ${document.language_code}`
                            : ''}
                          {document.is_current === false ? ' · superseded' : ''}
                          {alreadySelected ? ' · added' : ''}
                        </span>
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selected.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {selected.map((document) => (
            <li key={document.id}>
              <span className="inline-flex max-w-full items-center gap-1.5 rounded-2xl border border-border bg-muted/60 py-1 pl-2.5 pr-1 text-xs">
                <span className="flex min-w-0 flex-col text-left">
                  <span className="truncate font-medium text-foreground">
                    {document.title || 'Unresolved document'}
                  </span>
                  <span className="truncate text-[0.6875rem] text-muted-foreground">
                    {document.document_kind
                      ? kindLabel(document.document_kind)
                      : document.id}
                  </span>
                </span>
                <Button
                  aria-label={`Remove ${document.title || document.id}`}
                  className="size-5 shrink-0 rounded-full"
                  onClick={() => removeDocument(document.id)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <XIcon className="size-3" />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/*
        The payload: one hidden input per selected document, read server-side with
        `formData.getAll('<name>')`. Rendered from state (never `defaultValue`) so a successful
        React 19 form action cannot reset them.
      */}
      {selected.map((document) => (
        <input
          key={`${name}-${document.id}`}
          name={name}
          type="hidden"
          value={document.id}
        />
      ))}

      {description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}
