'use client';

import { Download, Star } from 'lucide-react';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import { CreateTestFromPromptsDialog } from '~/components/admin/tests/CreateTestFromPromptsDialog';
import { DeleteTestPromptDialog } from '~/components/admin/tests/DeleteTestPromptDialog';
import { EditTestItemDialog } from '~/components/admin/tests/EditTestItemDialog';
import { ExpectedSourcesDialog } from '~/components/admin/tests/ExpectedSourcesDialog';
import type { TestItemSuggestionLists } from '~/components/admin/tests/TestItemFields';
import { ITEM_ANCHOR_PREFIX, itemAnchorId } from '~/lib/tests/item-anchor';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Checkbox } from '~/components/ui/checkbox';
import { Input } from '~/components/ui/input';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import {
  formatElapsed,
  formatPercent,
  formatYesNoExport,
  formatSimilarityPercent,
} from '~/lib/tests/format';
import type { GoldenSetItemOrigin } from '~/lib/tests/golden-set';
import type { TestPickerOption } from '~/lib/tests/repository';
import { escapeCsvCell, sanitizeCsvFilename } from '~/lib/utils/csv';
import type { Json } from '~/types/supabase.public';

import { formatMultiTurnJsonCell } from '~/lib/tests/csv';
import {
  formatMultiTurnBadgeLabel,
  formatMultiTurnTurnsTooltip,
  readMultiTurnItemView,
} from '~/lib/tests/multi-turn-display';

export type TestPromptRow = {
  id: string;
  row_index: number;
  prompt: string;
  /** B0-993 — product line keys, one per element; exported pipe-delimited under `canonical_product`. */
  expected_canonical_products: string[];
  expected_reason_code: string | null;
  source: string | null;
  priority: number | null;
  ideal_response: string | null;
  /** B0-933 — one concept phrase per element; rendered and exported verbatim. */
  expected_concepts: string[];
  minimum_concepts: string[];
  /** B0-933 — `rag.document.id` uuids, resolved to titles for display by the server component. */
  expected_sources: string[];
  should_cite: boolean | null;
  input_payload: Json;
};

/** The importer splits phrase cells on `|`, so display and export both join on it (B0-933). */
const PHRASE_DELIMITER = ' | ';

function subscribeToHashChange(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

/**
 * Regulated free text: phrases are joined structurally and never reformatted — no rounding,
 * unit conversion, re-casing or string truncation of a ratio, ppm, contact time, CAS or EPA
 * number. Clamping is CSS-only, with the full value in `title`.
 */
function joinPhrases(phrases: readonly string[]): string {
  return phrases.join(PHRASE_DELIMITER);
}

/**
 * `expected_sources` holds `rag.document.id` uuids. A bare uuid tells a reviewer nothing, so the
 * document title is shown instead; an id with no live document is marked rather than dropped —
 * silently omitting it would read as "this row expects no source".
 */
function formatExpectedSource(
  documentId: string,
  documentTitlesById: Record<string, string>,
): string {
  const title = documentTitlesById[documentId];
  return title ? title : `Unresolved document (${documentId})`;
}

/** Aggregated history for a single `test_item` across the recent runs surfaced on this page. */
export type TestPromptAggregation = {
  runCount: number;
  passCount: number;
  failCount: number;
  passRatePercent: number | null;
  avgSimilarity: number | null;
  avgElapsedMs: number | null;
  latestRun: {
    runId: string;
    passed: boolean;
  } | null;
};

function payloadString(payload: Json, key: string): string {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    return '';
  }
  const raw = (payload as Record<string, unknown>)[key];
  return typeof raw === 'string' ? raw : '';
}

function rowMatchesQuery(
  item: TestPromptRow,
  raw: string,
  documentTitlesById: Record<string, string>,
): boolean {
  const q = raw.trim().toLowerCase();
  if (!q) {
    return true;
  }
  if (item.prompt.toLowerCase().includes(q)) {
    return true;
  }
  if (String(item.row_index).includes(q)) {
    return true;
  }
  // Concept/source expectations are the main reason to hunt for a row (e.g. "13 oz/gal").
  if (
    [
      ...item.expected_concepts,
      ...item.minimum_concepts,
      // Match what the cell shows (document titles), not the raw uuids behind it.
      ...item.expected_sources.map((id) => formatExpectedSource(id, documentTitlesById)),
    ].some((value) => value.toLowerCase().includes(q))
  ) {
    return true;
  }
  // B0-537 — only turn 1 lives in `prompt`, so later turns are otherwise unsearchable.
  const view = readMultiTurnItemView(item.input_payload);
  return (
    view.kind === 'multi_turn' &&
    view.scenario.turns.some((turn) => turn.prompt.toLowerCase().includes(q))
  );
}

/**
 * Compact read-only view of the golden-set expectation fields. Values are rendered
 * verbatim (clamped, with the full text in `title`) — never reformatted, since they
 * carry regulated figures such as oz/gal, mL/L, ppm, and contact times.
 */
function ConceptExpectationsCell({
  item,
  documentTitlesById,
}: {
  item: TestPromptRow;
  documentTitlesById: Record<string, string>;
}) {
  const usesMinimum = item.minimum_concepts.length > 0;
  const concepts = usesMinimum ? item.minimum_concepts : item.expected_concepts;
  const conceptsLabel = joinPhrases(concepts);
  const sourceLabels = item.expected_sources.map((id) =>
    formatExpectedSource(id, documentTitlesById),
  );
  const hasAny =
    concepts.length > 0 ||
    sourceLabels.length > 0 ||
    item.should_cite !== null;

  if (!hasAny) {
    return <span className="text-slate-400">—</span>;
  }

  return (
    <div className="flex flex-col gap-1">
      {concepts.length > 0 ? (
        <span className="line-clamp-2 whitespace-normal" title={conceptsLabel}>
          {usesMinimum ? 'Min: ' : 'Expected: '}
          {conceptsLabel}
        </span>
      ) : null}
      {sourceLabels.length > 0 ? (
        // B0-994 — the whole string is the trigger; the dialog shows each document as a card.
        <ExpectedSourcesDialog
          label={sourceLabels.join(PHRASE_DELIMITER)}
          rowIndex={item.row_index}
          sources={item.expected_sources.map((id) => ({
            id,
            title: documentTitlesById[id] ?? null,
          }))}
        />
      ) : null}
      {item.should_cite !== null ? (
        <Badge
          className="w-fit text-slate-500"
          title={
            item.should_cite
              ? 'This row expects the answer to cite sources.'
              : 'This row expects the answer not to cite sources.'
          }
          variant="secondary"
        >
          {item.should_cite ? 'Must cite' : 'No cite'}
        </Badge>
      ) : null}
    </div>
  );
}

/**
 * B0-537 — marks a row that is an ordered multi-turn scenario rather than a single prompt. Rendered
 * inside the existing Prompt cell (rather than as a new column) so the table's `colSpan`s and the
 * re-uploadable CSV column order stay untouched.
 */
function MultiTurnRowBadge({ item }: { item: TestPromptRow }) {
  const view = readMultiTurnItemView(item.input_payload);

  if (view.kind === 'single_turn') {
    return null;
  }

  if (view.kind === 'invalid') {
    return (
      <Badge
        className="mr-2 align-middle"
        title={view.message}
        variant="destructive"
      >
        Multi-turn · invalid
      </Badge>
    );
  }

  return (
    <Badge
      className="mr-2 border-sky-600/45 bg-sky-600/12 align-middle text-sky-900 dark:border-sky-500/40 dark:bg-sky-500/15 dark:text-sky-50"
      title={formatMultiTurnTurnsTooltip(view.scenario)}
      variant="outline"
    >
      {formatMultiTurnBadgeLabel(view.turnCount)}
      {view.scenario.assertions?.length
        ? ` · ${view.scenario.assertions.length} assertion${view.scenario.assertions.length === 1 ? '' : 's'}`
        : ''}
    </Badge>
  );
}

/** Tooltip copy for the Golden badge: matched golden test name(s) and the rule(s) that matched. */
function formatGoldenOriginTooltip(origin: GoldenSetItemOrigin): string {
  const names = origin.goldenTests.map((test) => test.name).join(', ');
  return `Golden set: ${names} · matched by ${origin.rules.join(', ')}`;
}

/**
 * B0-750 — marks a row that belongs to a golden test set, by lineage (derived from a golden
 * test) or because the same prompt exists verbatim in a golden test. Rendered inside the Prompt
 * cell like `MultiTurnRowBadge` so `colSpan`s and the CSV column order stay untouched.
 */
function GoldenRowBadge({ origin }: { origin: GoldenSetItemOrigin | undefined }) {
  if (!origin) {
    return null;
  }
  return (
    <Badge
      className="mr-2 border-amber-600/45 bg-amber-500/12 align-middle text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-50"
      title={formatGoldenOriginTooltip(origin)}
      variant="outline"
    >
      Golden
    </Badge>
  );
}

type TestPromptsSectionProps = {
  items: TestPromptRow[];
  returnPath: string;
  testId: string;
  /** Used for the downloaded CSV filename. */
  datasetName: string;
  /** Per-prompt aggregation keyed by `test_item.id`. Items without history are simply absent. */
  aggregationsByItemId: Record<string, TestPromptAggregation>;
  /** Total number of recent runs the aggregations were computed over (drives column tooltips). */
  aggregatedRunCount: number;
  /** `ProdLineKey` → display name for the edit dialog's canonical product field. */
  canonicalProductLabels: Record<string, string>;
  /** Combobox suggestion values shared with the add/edit prompt dialogs. */
  suggestionLists: TestItemSuggestionLists;
  /** B0-750 — golden-set origin keyed by `test_item.id`; items with no golden origin are absent. */
  goldenOriginsByItemId: Record<string, GoldenSetItemOrigin>;
  /**
   * B0-933 — `rag.document.id` → title for every id referenced by `expected_sources` on this
   * page. Resolved in one batched query by the server component; ids with no live document are
   * simply absent and render as unresolved.
   */
  documentTitlesById: Record<string, string>;
  /** B0-1098 — active tests the selection can be appended to (the current test already excluded). */
  mergeTargets: TestPickerOption[];
};

export function TestPromptsSection({
  items,
  returnPath,
  testId,
  datasetName,
  aggregationsByItemId,
  aggregatedRunCount,
  canonicalProductLabels,
  suggestionLists,
  goldenOriginsByItemId,
  documentTitlesById,
  mergeTargets,
}: TestPromptsSectionProps) {
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  // B0-1145 — `/admin/tests/[testId]#item-<id>` links from the prompt search dialog. The admin
  // layout scrolls inside a nested div (not the window) and client-side `pushState` navigation
  // never updates `:target`, so the browser's own fragment handling can't land on the row.
  const hash = useSyncExternalStore(
    subscribeToHashChange,
    () => window.location.hash,
    () => '',
  );
  const highlightedItemId = hash.startsWith(ITEM_ANCHOR_PREFIX)
    ? hash.slice(ITEM_ANCHOR_PREFIX.length)
    : null;

  useEffect(() => {
    if (!highlightedItemId) {
      return;
    }
    document
      .getElementById(itemAnchorId(highlightedItemId))
      ?.scrollIntoView({ block: 'center' });
  }, [highlightedItemId]);

  const filtered = useMemo(
    () => items.filter((item) => rowMatchesQuery(item, query, documentTitlesById)),
    [items, query, documentTitlesById],
  );

  const total = items.length;
  const showing = filtered.length;

  const { promptsWithSimilarity, promptsInAggregations } = useMemo(() => {
    const aggs = Object.values(aggregationsByItemId);
    return {
      promptsInAggregations: aggs.length,
      promptsWithSimilarity: aggs.filter((a) => a.avgSimilarity !== null).length,
    };
  }, [aggregationsByItemId]);

  /** Header checkbox state — based on currently visible (filtered) rows. */
  const visibleSelectedCount = useMemo(
    () =>
      filtered.reduce((sum, row) => sum + (selectedIds.has(row.id) ? 1 : 0), 0),
    [filtered, selectedIds],
  );
  const allVisibleSelected =
    filtered.length > 0 && visibleSelectedCount === filtered.length;
  const someVisibleSelected =
    visibleSelectedCount > 0 && visibleSelectedCount < filtered.length;

  const orderedSelectedIds = useMemo(
    () =>
      [...items]
        .sort((a, b) => a.row_index - b.row_index)
        .filter((item) => selectedIds.has(item.id))
        .map((item) => item.id),
    [items, selectedIds],
  );

  const toggleRow = useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const toggleAllVisible = useCallback(
    (checked: boolean) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const row of filtered) {
          if (checked) {
            next.add(row.id);
          } else {
            next.delete(row.id);
          }
        }
        return next;
      });
    },
    [filtered],
  );

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const goldenItemIds = useMemo(
    () => items.filter((item) => goldenOriginsByItemId[item.id]).map((item) => item.id),
    [items, goldenOriginsByItemId],
  );

  /** Replaces (not extends) the selection — the point is an exact golden-only subset. */
  const selectGoldenItems = useCallback(() => {
    setSelectedIds(new Set(goldenItemIds));
  }, [goldenItemIds]);

  const downloadCsv = useCallback(() => {
    if (items.length === 0) {
      return;
    }

    const sorted = [...items].sort((a, b) => a.row_index - b.row_index);
    // Column order matches TEST_TEMPLATE_COLUMNS so a download can be re-uploaded as-is.
    const headers = [
      'question',
      'canonical_product',
      'reason_code',
      'source',
      'priority',
      'ideal_response',
      'product_mention',
      'question_category',
      'source_style',
      'expected_concepts',
      'minimum_concepts',
      'expected_sources',
      'should_cite',
      // B0-537 — so a downloaded set round-trips its scenarios on re-upload.
      'multi_turn_json',
    ];

    const lines = [
      headers.join(','),
      ...sorted.map((item) =>
        [
          item.prompt,
          joinPhrases(item.expected_canonical_products),
          item.expected_reason_code ?? '',
          item.source ?? '',
          item.priority === null ? '' : String(item.priority),
          item.ideal_response ?? '',
          payloadString(item.input_payload, 'product_mention'),
          payloadString(item.input_payload, 'question_category'),
          payloadString(item.input_payload, 'source_style'),
          joinPhrases(item.expected_concepts),
          joinPhrases(item.minimum_concepts),
          // Round-trips as ids — the importer resolves `expected_sources` to `rag.document.id`.
          joinPhrases(item.expected_sources),
          formatYesNoExport(item.should_cite),
          (() => {
            const view = readMultiTurnItemView(item.input_payload);
            return view.kind === 'multi_turn'
              ? formatMultiTurnJsonCell(view.scenario)
              : '';
          })(),
        ]
          .map(escapeCsvCell)
          .join(','),
      ),
    ];

    const blob = new Blob([`\ufeff${lines.join('\r\n')}`], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${sanitizeCsvFilename(datasetName)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [datasetName, items]);

  return (
    <>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-slate-900">
            Test prompts ({total})
          </h2>
          {query.trim() ? (
            <p className="mt-1 text-sm text-slate-500">
              Showing {showing} of {total} matching &ldquo;{query.trim()}&rdquo;
            </p>
          ) : null}
          {selectedIds.size > 0 ? (
            <p className="mt-1 text-sm text-slate-500">
              {selectedIds.size} selected ·{' '}
              <button
                className="text-sky-700 underline-offset-2 hover:underline"
                onClick={clearSelection}
                type="button"
              >
                Clear selection
              </button>
            </p>
          ) : null}
        </div>
        <div className="flex w-full items-center gap-2 lg:max-w-2xl lg:flex-[0_1_44rem]">
          <Input
            autoComplete="off"
            className="min-w-0 flex-1 rounded-2xl"
            id="test-prompts-filter"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by prompt text, row number, concepts, or sources…"
            type="search"
            value={query}
          />
          <Button
            aria-label={`Select the ${goldenItemIds.length} prompts that belong to a golden test set, replacing the current selection`}
            className="shrink-0 rounded-2xl"
            disabled={goldenItemIds.length === 0}
            onClick={selectGoldenItems}
            size="sm"
            title="Selects prompts that belong to a golden test set — by lineage (derived from a golden test) or because the same prompt exists in a golden test."
            type="button"
            variant="outline"
          >
            <Star className="size-4" />
            Select golden-set prompts ({goldenItemIds.length})
          </Button>
          <CreateTestFromPromptsDialog
            existingTests={mergeTargets}
            returnPath={returnPath}
            selectedTestItemIds={orderedSelectedIds}
            sourceTestId={testId}
            sourceTestName={datasetName}
          />
          <Button
            aria-label="Download all test prompts as CSV"
            className="size-9 shrink-0 rounded-2xl"
            disabled={total === 0}
            onClick={downloadCsv}
            size="icon"
            type="button"
            variant="outline"
          >
            <Download className="size-4" />
          </Button>
        </div>
      </div>

      {aggregatedRunCount > 0 ? (
        <p className="mt-2 text-xs text-slate-500">
          Historical metrics aggregate up to the last {aggregatedRunCount} run
          {aggregatedRunCount === 1 ? '' : 's'} for this dataset.
          {promptsInAggregations > 0 ? (
            <>
              {' '}
              Similarity scores available for{' '}
              <span className="font-medium text-slate-700">
                {promptsWithSimilarity} of {promptsInAggregations}
              </span>{' '}
              prompts that have run.
            </>
          ) : null}
        </p>
      ) : null}

      <div className="relative mt-4 max-h-[min(48vh,32rem)] overflow-auto overscroll-contain rounded-2xl border border-slate-200">
        <table className="w-full min-w-6xl caption-bottom text-sm">
          <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226_232_240)] [&_tr]:border-b-0">
            <TableRow>
              <TableHead className="w-[1%] whitespace-nowrap">
                <Checkbox
                  aria-label={
                    allVisibleSelected
                      ? 'Deselect all visible prompts'
                      : 'Select all visible prompts'
                  }
                  checked={
                    allVisibleSelected
                      ? true
                      : someVisibleSelected
                        ? 'indeterminate'
                        : false
                  }
                  disabled={filtered.length === 0}
                  onCheckedChange={(value) => toggleAllVisible(value === true)}
                />
              </TableHead>
              <TableHead>Row</TableHead>
              <TableHead>Prompt</TableHead>
              <TableHead title="Concept, source, and citation expectations for this prompt: expected/minimum concept phrases, the rag documents listed in expected_sources (click Sources to read them), and should_cite.">
                Concepts / sources
              </TableHead>
              <TableHead title="Number of recent runs that included this prompt (and the passed/failed counts).">
                Pass/Total
              </TableHead>
              <TableHead
                className="whitespace-nowrap"
                title="Share of recent runs in which this prompt passed."
              >
                Pass %
              </TableHead>
              <TableHead
                className="whitespace-nowrap"
                title="Average of the max per-source retrieval similarity across recent runs (same basis as the trend chart)."
              >
                Sim avg
              </TableHead>
              <TableHead
                className="whitespace-nowrap"
                title="Mean wall-clock prompt elapsed time across recent runs."
              >
                Avg elapsed
              </TableHead>
              <TableHead
                className="whitespace-nowrap"
                title="Pass/fail outcome from the most recent run that included this prompt."
              >
                Last run
              </TableHead>
              <TableHead className="w-[1%] whitespace-nowrap">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell className="text-slate-500" colSpan={10}>
                  {total === 0
                    ? 'No prompts in this dataset yet.'
                    : 'No prompts match your search.'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((item) => {
                const isSelected = selectedIds.has(item.id);
                const stats = aggregationsByItemId[item.id];
                const hasHistory = !!stats && stats.runCount > 0;
                return (
                  <TableRow
                    key={item.id}
                    className={
                      highlightedItemId === item.id
                        ? 'bg-sky-50 ring-1 ring-sky-200 ring-inset'
                        : undefined
                    }
                    data-state={isSelected ? 'selected' : undefined}
                    id={itemAnchorId(item.id)}
                  >
                    <TableCell>
                      <Checkbox
                        aria-label={`Select prompt row ${item.row_index}`}
                        checked={isSelected}
                        onCheckedChange={(value) =>
                          toggleRow(item.id, value === true)
                        }
                      />
                    </TableCell>
                    <TableCell>{item.row_index}</TableCell>
                    <TableCell className="max-w-[420px] whitespace-normal">
                      {item.priority !== null ? (
                        <Badge
                          className="mr-2 align-middle text-slate-500"
                          title={`Priority ${item.priority} — lower = more important`}
                          variant="secondary"
                        >
                          P{item.priority}
                        </Badge>
                      ) : null}
                      <GoldenRowBadge origin={goldenOriginsByItemId[item.id]} />
                      <MultiTurnRowBadge item={item} />
                      {item.prompt}
                    </TableCell>
                    <TableCell className="max-w-65 align-top text-xs text-slate-600">
                      <ConceptExpectationsCell
                        documentTitlesById={documentTitlesById}
                        item={item}
                      />
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap tabular-nums text-slate-700"
                      title={
                        hasHistory
                          ? `${stats!.runCount} run${stats!.runCount === 1 ? '' : 's'} aggregated`
                          : 'No historical runs yet for this prompt.'
                      }
                    >
                      {hasHistory ? (
                        <span>
                          {stats!.passCount}/{stats!.runCount}
                        </span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums text-slate-700">
                      {formatPercent(stats?.passRatePercent ?? null)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums text-slate-700">
                      {formatSimilarityPercent(stats?.avgSimilarity ?? null)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums text-slate-700">
                      {formatElapsed(stats?.avgElapsedMs ?? null)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {stats?.latestRun ? (
                        <Link
                          className="inline-block"
                          href={`/admin/tests/${testId}/runs/${stats.latestRun.runId}#item-level-results`}
                          title={`View run ${stats.latestRun.runId}`}
                        >
                          <Badge
                            className={
                              stats.latestRun.passed
                                ? 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900 hover:bg-emerald-600/20 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-50'
                                : undefined
                            }
                            variant={
                              stats.latestRun.passed ? 'outline' : 'destructive'
                            }
                          >
                            {stats.latestRun.passed ? 'Pass' : 'Fail'}
                          </Badge>
                        </Link>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <EditTestItemDialog
                          canonicalProductLabels={canonicalProductLabels}
                          expectedCanonicalProducts={
                            item.expected_canonical_products
                          }
                          expectedConcepts={item.expected_concepts}
                          expectedReasonCode={item.expected_reason_code}
                          expectedSources={item.expected_sources}
                          idealResponse={item.ideal_response}
                          inputPayload={item.input_payload}
                          minimumConcepts={item.minimum_concepts}
                          priority={item.priority}
                          prompt={item.prompt}
                          returnPath={returnPath}
                          rowIndex={item.row_index}
                          shouldCite={item.should_cite}
                          source={item.source}
                          suggestionLists={suggestionLists}
                          testId={testId}
                          testItemId={item.id}
                        />
                        <DeleteTestPromptDialog
                          promptPreview={item.prompt}
                          returnPath={returnPath}
                          rowIndex={item.row_index}
                          testId={testId}
                          testItemId={item.id}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </table>
      </div>
    </>
  );
}
