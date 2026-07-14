import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { AdminTestsActionToast } from '~/components/admin/tests/AdminTestsActionToast';
import { RunExecutionProgress } from '~/components/admin/tests/RunExecutionProgress';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import {
  countResultItemsByResultId,
  getTestById,
  getTestItemsByTestId,
  getTestResultById,
  listAllResultItemsByResultId,
} from '~/lib/tests/repository';
import { formatExpectedShouldAnswerLabel } from '~/lib/tests/format';
import { formatDate, formatDurationSeconds } from '~/lib/utils/time';
import {
  extractProgress,
  extractSearchRunEmbeddingSource,
  extractSearchRunMatches,
  extractSearchRunMaxSimilarity,
  extractSearchRunPassReason,
  extractSearchRunTotalMs,
} from '~/lib/tests/response-payload';

import { deleteSearchRunAction } from '../../../actions';

export const metadata = {
  title: 'Search Eval Run | Betco BEX',
  description: 'Inspect per-prompt search results for a search eval run.',
};

type PageProps = {
  params: Promise<{ testId: string; runId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminSearchRunDetailsPage({
  params,
  searchParams,
}: PageProps) {
  await connection();
  const { testId, runId } = await params;
  const query = await searchParams;
  const success = typeof query.success === 'string' ? query.success : null;
  const error = typeof query.error === 'string' ? query.error : null;

  const [test, result] = await Promise.all([
    getTestById(testId).catch(() => null),
    getTestResultById(runId).catch(() => null),
  ]);

  if (!test || !result || result.test_id !== test.id || result.run_mode !== 'search') {
    notFound();
  }

  const [allResultItems, testItems, completedFromRows] = await Promise.all([
    listAllResultItemsByResultId(result.id),
    getTestItemsByTestId(test.id),
    countResultItemsByResultId(result.id),
  ]);

  const progress = extractProgress(result.summary, result.total_items);
  const initialTotalItems = Math.max(progress.totalItems, result.total_items);
  const initialCompletedItemsRaw = Math.max(
    progress.completedItems,
    completedFromRows,
    result.passed_items + (result.failed_items ?? 0),
  );
  const initialCompletedItems =
    initialTotalItems > 0
      ? Math.min(initialTotalItems, initialCompletedItemsRaw)
      : initialCompletedItemsRaw;

  const promptByItemId = new Map(testItems.map((item) => [item.id, item.prompt]));
  const shouldAnswerByItemId = new Map(
    testItems.map((item) => [item.id, item.expected_should_answer]),
  );

  const passCount = result.passed_items ?? 0;
  const failCount = result.failed_items ?? allResultItems.filter((item) => !item.passed).length;
  const incompleteCount = Math.max(0, result.total_items - passCount - failCount);

  type ItemCategory = 'negative' | 'unconstrained' | 'product_only' | 'section_only' | 'both_constraints';
  function categorizeItem(item: (typeof testItems)[number]): ItemCategory {
    if (item.expected_should_answer === false) return 'negative';
    const hasProduct = typeof item.expected_canonical_product === 'string' && item.expected_canonical_product.trim() !== '';
    const hasSection = typeof item.expected_result_type === 'string' && item.expected_result_type.trim() !== '';
    if (hasProduct && hasSection) return 'both_constraints';
    if (hasProduct) return 'product_only';
    if (hasSection) return 'section_only';
    return 'unconstrained';
  }

  const categoryMeta: Record<ItemCategory, { label: string; description: string }> = {
    negative: { label: 'Negative / OOD', description: 'Out-of-domain queries that should return no relevant match' },
    unconstrained: { label: 'Unconstrained', description: 'Any match is a pass — no product or section constraint' },
    product_only: { label: 'Product match', description: 'Must match expected product line' },
    section_only: { label: 'Section match', description: 'Must match expected document section type' },
    both_constraints: { label: 'Product + section', description: 'Must satisfy both product line and section type in the same chunk' },
  };

  const categoryItemIds = new Map<ItemCategory, Set<string>>();
  for (const category of Object.keys(categoryMeta) as ItemCategory[]) {
    categoryItemIds.set(category, new Set());
  }
  for (const item of testItems) {
    categoryItemIds.get(categorizeItem(item))!.add(item.id);
  }

  const resultByItemId = new Map(allResultItems.map((r) => [r.test_item_id, r]));

  const categoryStats = (Object.keys(categoryMeta) as ItemCategory[]).map((cat) => {
    const ids = categoryItemIds.get(cat)!;
    let total = 0;
    let passed = 0;
    let simSum = 0;
    let simCount = 0;
    for (const id of ids) {
      const r = resultByItemId.get(id);
      if (!r) continue;
      total += 1;
      if (r.passed) passed += 1;
      const sim = extractSearchRunMaxSimilarity(r.response_payload);
      if (sim !== null) { simSum += sim; simCount += 1; }
    }
    return {
      category: cat,
      label: categoryMeta[cat].label,
      description: categoryMeta[cat].description,
      total,
      passed,
      passRate: total > 0 ? passed / total : null,
      avgSim: simCount > 0 ? simSum / simCount : null,
    };
  }).filter((s) => s.total > 0);

  const chronologicalItems = [...allResultItems].sort((a, b) => {
    if (a.created_at === b.created_at) return a.row_index - b.row_index;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  const similarities = chronologicalItems
    .map((item) => extractSearchRunMaxSimilarity(item.response_payload))
    .filter((v): v is number => v !== null);
  const avgSimilarity =
    similarities.length > 0
      ? similarities.reduce((sum, v) => sum + v, 0) / similarities.length
      : null;

  return (
    <div className="flex flex-1 bg-slate-50">
      <AdminTestsActionToast error={error} success={success} />
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
                Search eval run
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
                {test.name}
              </h1>
              <p className="mt-3 font-mono text-xs text-slate-600">
                Run id: {result.id}
              </p>
              {avgSimilarity !== null ? (
                <p className="mt-1 text-sm text-slate-600">
                  Avg max similarity:{' '}
                  <span className="font-medium tabular-nums">
                    {(avgSimilarity * 100).toFixed(1)}%
                  </span>
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild size="sm" variant="outline">
                <Link href={`/admin/tests/${test.id}`}>Back to test</Link>
              </Button>
              <form action={deleteSearchRunAction}>
                <input
                  name="returnPath"
                  type="hidden"
                  value={`/admin/tests/${test.id}`}
                />
                <input name="testId" type="hidden" value={test.id} />
                <input name="runId" type="hidden" value={result.id} />
                <Button size="sm" type="submit" variant="destructive">
                  Delete run
                </Button>
              </form>
            </div>
          </div>
        </section>

        <RunExecutionProgress
          initialCompletedItems={initialCompletedItems}
          initialElapsedMs={result.elapsed_ms ?? 0}
          initialStatus={result.status}
          initialTotalItems={initialTotalItems}
          runId={result.id}
          stats={{
            passCount,
            failCount,
            erroredCount: 0,
            incompleteCount,
            started_at: result.started_at ?? '',
          }}
        />

        {categoryStats.length > 0 ? (
          <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
            <h2 className="mb-1 text-lg font-semibold text-slate-900">
              Gold eval by category
            </h2>
            <p className="mb-4 text-sm text-slate-500">
              Strategy: <span className="font-medium text-slate-700">{result.retrieval_strategy ?? 'vector'}</span>
            </p>
            <div className="overflow-auto rounded-2xl border border-slate-200">
              <table className="w-full caption-bottom text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold text-slate-700">Category</th>
                    <th className="px-4 py-2.5 text-right font-semibold text-slate-700" title="Total items in this category">N</th>
                    <th className="px-4 py-2.5 text-right font-semibold text-slate-700">Passed</th>
                    <th className="px-4 py-2.5 text-right font-semibold text-slate-700">Pass %</th>
                    <th className="px-4 py-2.5 text-right font-semibold text-slate-700" title="Average of per-item max similarity scores">Avg sim</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {categoryStats.map((s) => (
                    <tr key={s.category}>
                      <td className="px-4 py-2.5">
                        <span className="font-medium text-slate-800">{s.label}</span>
                        <span className="ml-2 text-xs text-slate-400">{s.description}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{s.total}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{s.passed}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {s.passRate !== null ? (
                          <span className={s.passRate >= 0.8 ? 'font-semibold text-emerald-700' : s.passRate >= 0.6 ? 'text-amber-700' : 'font-semibold text-red-700'}>
                            {(s.passRate * 100).toFixed(0)}%
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">
                        {s.avgSim !== null ? `${(s.avgSim * 100).toFixed(1)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <section
          className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm"
          id="search-results"
        >
          <h2 className="mb-4 text-lg font-semibold text-slate-900">
            Per-prompt results
          </h2>
          <div className="relative max-h-[min(70vh,52rem)] overflow-auto overscroll-contain rounded-2xl border border-slate-200">
            <table className="w-full min-w-[900px] caption-bottom text-sm">
              <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226_232_240)] [&_tr]:border-b-0">
                <TableRow>
                  <TableHead>Row</TableHead>
                  <TableHead>Prompt</TableHead>
                  <TableHead title="Whether this prompt is expected to be answered (from test item metadata)">
                    Should answer?
                  </TableHead>
                  <TableHead title="Whether this item passed the gold eval criteria (product line, section type, negative test threshold)">
                    Pass?
                  </TableHead>
                  <TableHead title="Query sent to vector search after rewrite">
                    Query used
                  </TableHead>
                  <TableHead title="Number of chunks returned">
                    Matches
                  </TableHead>
                  <TableHead title="Highest similarity score among returned chunks">
                    Max sim
                  </TableHead>
                  <TableHead>Embedding</TableHead>
                  <TableHead title="Total search time (ms)">Time</TableHead>
                  <TableHead>Top chunks</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {chronologicalItems.length === 0 ? (
                  <TableRow>
                    <TableCell className="text-slate-500" colSpan={10}>
                      No results yet — run is still in progress.
                    </TableCell>
                  </TableRow>
                ) : (
                  chronologicalItems.map((row) => {
                    const prompt = promptByItemId.get(row.test_item_id) || 'n/a';
                    const matches = extractSearchRunMatches(row.response_payload);
                    const maxSim = extractSearchRunMaxSimilarity(row.response_payload);
                    const embeddingSource = extractSearchRunEmbeddingSource(row.response_payload);
                    const totalMs = extractSearchRunTotalMs(row.response_payload);
                    const payload = row.response_payload as Record<string, unknown> | null;
                    const queryUsed =
                      payload && typeof payload.query === 'string'
                        ? payload.query
                        : null;
                    const queryRewritten =
                      payload && typeof payload.queryRewritten === 'string'
                        ? payload.queryRewritten
                        : null;
                    const displayQuery = queryRewritten ?? queryUsed;
                    const isRewritten = Boolean(queryRewritten);

                    const shouldAnswer = shouldAnswerByItemId.get(row.test_item_id);
                    const passReason = extractSearchRunPassReason(row.response_payload);
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="tabular-nums">
                          {row.row_index}
                        </TableCell>
                        <TableCell className="max-w-[280px] whitespace-normal text-xs text-slate-700">
                          {prompt}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <Badge
                            className={
                              shouldAnswer === true
                                ? 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900'
                                : undefined
                            }
                            variant={
                              shouldAnswer === null || shouldAnswer === undefined
                                ? 'secondary'
                                : shouldAnswer === true
                                  ? 'outline'
                                  : 'destructive'
                            }
                          >
                            {formatExpectedShouldAnswerLabel(shouldAnswer ?? null)}
                          </Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <Badge
                            className={row.passed ? 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900' : undefined}
                            title={passReason ?? undefined}
                            variant={row.passed ? 'outline' : 'destructive'}
                          >
                            {row.passed ? 'pass' : 'fail'}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[280px] whitespace-normal text-xs">
                          {displayQuery ? (
                            <span
                              className={
                                isRewritten ? 'italic text-amber-700' : 'text-slate-600'
                              }
                              title={
                                isRewritten
                                  ? `Rewritten from: ${queryUsed}`
                                  : undefined
                              }
                            >
                              {displayQuery}
                            </span>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          <Badge
                            variant={
                              matches.length === 0 ? 'destructive' : 'outline'
                            }
                          >
                            {matches.length}
                          </Badge>
                        </TableCell>
                        <TableCell className="tabular-nums text-slate-700">
                          {maxSim !== null
                            ? `${(maxSim * 100).toFixed(1)}%`
                            : '—'}
                        </TableCell>
                        <TableCell className="text-xs text-slate-600">
                          {embeddingSource ?? '—'}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-slate-600">
                          {totalMs !== null
                            ? formatDurationSeconds(totalMs)
                            : formatDurationSeconds(row.elapsed_ms)}
                        </TableCell>
                        <TableCell className="max-w-[320px] whitespace-normal text-xs text-slate-600">
                          {matches.length === 0 ? (
                            <span className="text-slate-400">no results</span>
                          ) : (
                            <ul className="space-y-1">
                              {matches.slice(0, 5).map((m, i) => (
                                <li key={i} className="flex items-baseline gap-1.5">
                                  <span className="shrink-0 font-medium tabular-nums text-slate-500">
                                    {(m.similarity * 100).toFixed(1)}%
                                  </span>
                                  <span className="truncate" title={m.chunk_text}>
                                    {m.document_title}
                                    {m.heading ? ` › ${m.heading}` : ''}
                                  </span>
                                  <Badge className="shrink-0" variant="secondary">
                                    {m.document_kind}
                                  </Badge>
                                </li>
                              ))}
                              {matches.length > 5 ? (
                                <li className="text-slate-400">
                                  +{matches.length - 5} more
                                </li>
                              ) : null}
                            </ul>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </table>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Showing {chronologicalItems.length} of {result.total_items} prompts
            {result.started_at ? ` — started ${formatDate(result.started_at)}` : ''}.
          </p>
        </section>
      </main>
    </div>
  );
}
