'use client';

import { Loader2Icon, SearchIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Switch } from '~/components/ui/switch';

/** Below this the type-ahead stays idle, matching `DocumentPickerField`'s threshold. */
const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 250;

/** Row shape returned by `GET /api/admin/tests/prompt-search`. */
type PromptSearchResult = {
  testItemId: string;
  prompt: string;
  testId: string;
  testName: string;
  isGolden: boolean;
  latestRunId: string | null;
};

type SearchState = {
  query: string;
  goldenOnly: boolean;
  results: PromptSearchResult[];
  error: string | null;
};

const EMPTY_SEARCH_STATE: SearchState = {
  query: '',
  goldenOnly: true,
  results: [],
  error: null,
};

/**
 * B0-1080 — global search over every prompt ever entered into `test_items`, from `/admin/tests`.
 * Jumps straight to a prompt's latest trace at `/admin/observability/[runId]` instead of making an
 * admin dig through test sets to find where a prompt lives.
 *
 * Follows `DocumentPickerField`'s debounced-server-search pattern (monotonic request sequence +
 * `AbortController` per request), but renders as a plain list rather than a `Command` popover: the
 * dialog header carries its own `<form>` (text input + submit button) per the ticket's ask, which
 * doesn't fit inside `Command`'s own input-driven filtering model.
 */
export function PromptSearchDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [goldenOnly, setGoldenOnly] = useState(true);
  const [search, setSearch] = useState<SearchState>(EMPTY_SEARCH_STATE);

  /** Monotonic request id — a slower earlier search must never overwrite a newer result. */
  const searchSeq = useRef(0);

  function runSearch(term: string, golden: boolean, controller: AbortController) {
    const seq = (searchSeq.current += 1);
    void (async () => {
      try {
        const response = await fetch(
          `/api/admin/tests/prompt-search?q=${encodeURIComponent(term)}&goldenOnly=${golden}`,
          { signal: controller.signal },
        );
        if (seq !== searchSeq.current) {
          return;
        }
        if (!response.ok) {
          setSearch({
            query: term,
            goldenOnly: golden,
            results: [],
            error: 'Prompt search failed. Try again.',
          });
          return;
        }
        const payload = (await response.json()) as {
          results?: PromptSearchResult[];
        };
        if (seq !== searchSeq.current) {
          return;
        }
        setSearch({
          query: term,
          goldenOnly: golden,
          results: payload.results ?? [],
          error: null,
        });
      } catch {
        if (!controller.signal.aborted && seq === searchSeq.current) {
          setSearch({
            query: term,
            goldenOnly: golden,
            results: [],
            error: 'Prompt search failed. Try again.',
          });
        }
      }
    })();
  }

  // Debounced live search as the admin types or toggles the switch.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      // Invalidate any in-flight request so its response can't land after the box is cleared.
      searchSeq.current += 1;
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      runSearch(trimmed, goldenOnly, controller);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, goldenOnly]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      return;
    }
    // Immediate, non-debounced search on top of the live debounced one — same search function.
    runSearch(trimmed, goldenOnly, new AbortController());
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      searchSeq.current += 1;
      setQuery('');
      setSearch(EMPTY_SEARCH_STATE);
    }
  }

  function handleResultClick(result: PromptSearchResult) {
    if (!result.latestRunId) {
      return;
    }
    setOpen(false);
    router.push(`/admin/observability/${result.latestRunId}`);
  }

  const trimmedQuery = query.trim();
  const isTyping = trimmedQuery.length >= MIN_QUERY_LENGTH;
  /** True while the debounce timer or the request for the current term/toggle is still outstanding. */
  const isSearching =
    isTyping &&
    (search.query !== trimmedQuery || search.goldenOnly !== goldenOnly);
  const results = isSearching ? [] : search.results;
  const errorMessage = isSearching ? null : search.error;

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogTrigger asChild>
        <Button aria-label="Search all prompts" size="icon" type="button" variant="outline">
          <SearchIcon className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Search prompts</DialogTitle>
          <DialogDescription>
            Search every prompt ever entered into the system and jump straight to its latest trace.
          </DialogDescription>
          <form className="flex items-center gap-2 pt-2" onSubmit={handleSubmit}>
            <Input
              aria-label="Search prompt text"
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search prompt text…"
              value={query}
            />
            <Button
              aria-label="Search"
              disabled={trimmedQuery.length < MIN_QUERY_LENGTH}
              size="icon"
              type="submit"
              variant="outline"
            >
              <SearchIcon className="size-4" />
            </Button>
          </form>
          <div className="flex items-center gap-2 pt-1">
            <Switch
              checked={goldenOnly}
              id="prompt-search-golden-only"
              onCheckedChange={setGoldenOnly}
              size="sm"
            />
            <Label
              className="text-xs font-normal text-muted-foreground"
              htmlFor="prompt-search-golden-only"
            >
              Golden dataset prompts only
            </Label>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {!isTyping ? (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">
              Type at least {MIN_QUERY_LENGTH} characters to search prompts.
            </p>
          ) : null}
          {isSearching ? (
            <p className="flex items-center justify-center gap-2 px-1 py-6 text-center text-xs text-muted-foreground">
              <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
              Searching…
            </p>
          ) : null}
          {isTyping && !isSearching && errorMessage ? (
            <p className="px-1 py-6 text-center text-xs text-destructive">
              {errorMessage}
            </p>
          ) : null}
          {isTyping && !isSearching && !errorMessage && results.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">
              No prompts match that search.
            </p>
          ) : null}
          {results.length > 0 ? (
            <ul className="flex flex-col gap-1.5 py-1">
              {results.map((result) => {
                const hasRun = Boolean(result.latestRunId);
                return (
                  <li key={result.testItemId}>
                    <button
                      className={
                        hasRun
                          ? 'w-full rounded-2xl border border-transparent bg-muted/40 px-3 py-2 text-left transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30'
                          : 'w-full cursor-not-allowed rounded-2xl border border-transparent bg-muted/20 px-3 py-2 text-left opacity-60'
                      }
                      disabled={!hasRun}
                      onClick={() => handleResultClick(result)}
                      type="button"
                    >
                      <p className="line-clamp-2 text-sm text-foreground">
                        {result.prompt}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {result.testName}
                        {result.isGolden ? ' · Golden' : ''}
                        {!hasRun ? ' · No trace yet' : ''}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
