'use client';

import { Download, FileDown, Loader2, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import {
  type ComponentProps,
  isValidElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { version as appVersion } from '~/../package.json';
import { DegradedRunBanner } from '~/components/admin/tests/DegradedRunBanner';
import { ProviderFaultBanner } from '~/components/admin/tests/ProviderFaultBanner';
import { ReportBreakdownCards } from '~/components/admin/tests/report/ReportBreakdownCards';
import { ReportCaseLedger } from '~/components/admin/tests/report/ReportCaseLedger';
import {
  ReportAggregateFindings,
  ReportExecutiveAssessment,
  ReportMethodology,
} from '~/components/admin/tests/report/ReportNarrativeSections';
import { ReportTopFixes } from '~/components/admin/tests/report/ReportTopFixes';
import { ReportVerdictStrip } from '~/components/admin/tests/report/ReportVerdictStrip';
import { BexStreamdown } from '~/components/bex/BexStreamdown';
import { Button } from '~/components/ui/button';
import type { GenerationRuntime } from '~/lib/llm/generation-runtime';
import type { ReportDataReady } from '~/lib/tests/report/data-schemas';
import { isInvariantErrorMessage } from '~/lib/tests/report/invariants';
import { caseAnchorId } from '~/lib/tests/report/render';
import type { RunRoutingHealth } from '~/lib/tests/run-health';
import type { RunProviderHealth } from '~/lib/tests/run-provider-health';
import { cn } from '~/lib/utils';

/** Matches a UUID anywhere in a case's heading blockquote text (`**question**` + `` `id` ``). */
const CASE_HEADING_ID_PATTERN =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** Exact `## …` line `render.ts` emits to open the case-by-case section. */
const CASE_SECTION_HEADING_LINE = '## Detailed results — case by case';
/** Any other `##` (not `###`) heading line — closes the case-by-case section. */
const NEXT_H2_LINE_PATTERN = /^##(?!#)\s/;
/** The `> **{question}**` line `render.ts` opens each case's heading blockquote with (B0-613). */
const CASE_HEADING_LINE_PATTERN = /^>\s*\*\*/;

/** B0-612 — alternating background so each case reads as one visually distinct group. */
const CASE_TONE_CLASSES = ['', 'rounded-2xl bg-slate-50'] as const;

type ReportMarkdownSections = {
  /** Everything through and including the "## Detailed results — case by case" heading. */
  before: string;
  /** Each case's own `### id — question` chunk, in order. */
  cases: string[];
  /** Everything from the next `##` heading (e.g. "## Aggregate findings") onward. */
  after: string;
};

/**
 * Pure split of the report markdown into the case-by-case section's individual cases, so each
 * one can be wrapped in its own alternating-background container (B0-612). Splitting the string
 * itself — rather than tracking a mutable "which case am I in" cursor across sibling renders —
 * keeps this a pure function of `markdown`, safe under React's render-must-be-pure rules (a
 * ref mutated during render can double-fire under Strict Mode/concurrent rendering and throw off
 * the alternation).
 */
function splitReportMarkdown(markdown: string): ReportMarkdownSections {
  const lines = markdown.split('\n');
  const sectionStart = lines.findIndex(
    (line) => line.trim() === CASE_SECTION_HEADING_LINE,
  );
  if (sectionStart === -1) {
    return { before: markdown, cases: [], after: '' };
  }

  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i += 1) {
    if (NEXT_H2_LINE_PATTERN.test(lines[i]!)) {
      sectionEnd = i;
      break;
    }
  }

  const before = lines.slice(0, sectionStart + 1).join('\n');
  const after = lines.slice(sectionEnd).join('\n');

  const cases: string[] = [];
  let current: string[] | null = null;
  for (const line of lines.slice(sectionStart + 1, sectionEnd)) {
    if (CASE_HEADING_LINE_PATTERN.test(line)) {
      if (current) cases.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
    // else: a line before the first case heading (e.g. the blank line render.ts leaves after the
    // section heading) — not part of any case, discarded rather than counted as a phantom one.
  }
  if (current) cases.push(current.join('\n'));

  // A report generated before the case-heading format last changed (e.g. B0-613's `### id —
  // question` → blockquote switch) won't match `CASE_HEADING_LINE_PATTERN` at all — rather than
  // silently dropping the whole section (every line here would otherwise belong to no case),
  // render it as one untoned block so old reports stay fully visible until regenerated.
  if (cases.length === 0) {
    return { before: markdown, cases: [], after: '' };
  }

  return { before, cases, after };
}

function reactNodeToText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(reactNodeToText).join('');
  if (isValidElement(node)) {
    return reactNodeToText((node.props as { children?: ReactNode }).children);
  }
  return '';
}

/**
 * Renders a case's heading blockquote (B0-613: bold question first, muted id below) and gives it
 * the stable anchor id `linkifyCaseIds` links back to — replaces the old `### id — question` h3.
 */
function ReportCaseQuote({
  children,
  className,
  ...rest
}: ComponentProps<'blockquote'>) {
  const match = CASE_HEADING_ID_PATTERN.exec(reactNodeToText(children));
  return (
    <blockquote
      className={cn(
        className,
        match &&
          '[&>p:first-child]:text-lg [&>p:first-child]:font-semibold [&>p:last-child]:mt-2 [&>p:last-child]:text-xs [&>p:last-child]:text-slate-500',
      )}
      id={match ? caseAnchorId(match[1]) : undefined}
      {...rest}
    >
      {children}
    </blockquote>
  );
}

/**
 * Same-page `#case-…` links must scroll, not navigate — `rehype-harden` (inside `streamdown`)
 * unconditionally stamps every link with `target="_blank"`, which would otherwise pop the anchor
 * open in a new tab instead of jumping to it in place.
 */
function ReportAnchorLink({ href, children, ...rest }: ComponentProps<'a'>) {
  if (typeof href === 'string' && href.startsWith('#')) {
    const targetId = href.slice(1);
    return (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          document
            .getElementById(targetId)
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

type ReportStatus =
  | 'idle'
  | 'scoring'
  | 'synthesizing'
  | 'completed'
  | 'failed';

function isTerminal(status: ReportStatus): boolean {
  return status === 'completed' || status === 'failed';
}

const MAX_AUTO_CONTINUES = 5;

type ReportStatusResponse = {
  ok?: boolean;
  status?: ReportStatus;
  totalCases?: number;
  completedCases?: number;
  /** B0-719 — independent grading passes per case. 1 on every report before multi-pass grading. */
  passes?: number;
  /** Finished (case, pass) grading units, and the `cases x passes` denominator that goes with it. */
  completedPasses?: number;
  totalPasses?: number;
  generatedAt?: string | null;
  error?: string | null;
};

function sanitizeFilename(name: string): string {
  const trimmed = name.trim() || 'run-report';
  return trimmed.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 100);
}

type RunReportViewProps = {
  runId: string;
  testId: string;
  testName: string;
  fileBase: string;
  initialStatus: ReportStatus;
  initialTotalCases: number;
  initialCompletedCases: number;
  /** B0-719 — the pass count this report is being graded at, so the operator sees what they set. */
  initialPasses: number;
  /** Finished (case, pass) units — what the progress bar counts. */
  initialCompletedPasses: number;
  initialError: string | null;
  initialGeneratedAt: string | null;
  isRunCompleted: boolean;
  /**
   * B0-707 — whether the viewer may download a case's workflow-run trace. Resolved server-side
   * from `navigation.sidebar.observability`, the permission the export route enforces.
   */
  canDownloadTrace: boolean;
  isGolden: boolean;
  /**
   * B0-905 — the model that ANSWERED this run (`summary.resolvedModel`) and its vendor, so the
   * methodology block can name both sides of the report. Null for a run that predates the field;
   * the block then omits the answering line rather than re-resolving a tag and stating a guess.
   */
  answeringModel?: string | null;
  answeringProvider?: string | null;
  /**
   * B0-912 — which generation loop served this run (`summary.generationRuntime`). Named beside the
   * answering model in the methodology block, because the loop is not a free choice: an Anthropic
   * model can only run on the AI SDK loop, so a vendor comparison is also a runtime comparison
   * unless someone says otherwise. Null for a run predating the field.
   */
  answeringRuntime?: GenerationRuntime | null;
  /**
   * B0-911 — this run's routing-pipeline health. When degraded, the banner renders ABOVE the
   * verdict strip: a grade produced on a degraded run must not be readable without that context.
   */
  routingHealth?: RunRoutingHealth | null;
  /**
   * B0-1014 — this run's provider health. When invalid, the banner renders ABOVE the degraded one
   * and above the verdict strip: a run the provider refused produced no answers to grade at all.
   */
  providerHealth?: RunProviderHealth | null;
};

export function RunReportView({
  runId,
  testId,
  testName,
  fileBase,
  initialStatus,
  initialTotalCases,
  initialCompletedCases,
  initialPasses,
  initialCompletedPasses,
  initialError,
  initialGeneratedAt,
  isRunCompleted,
  canDownloadTrace,
  isGolden,
  answeringModel = null,
  answeringProvider = null,
  answeringRuntime = null,
  routingHealth = null,
  providerHealth = null,
}: RunReportViewProps) {
  const [status, setStatus] = useState<ReportStatus>(initialStatus);
  const [totalCases, setTotalCases] = useState(initialTotalCases);
  const [completedCases, setCompletedCases] = useState(initialCompletedCases);
  const [passes, setPasses] = useState(initialPasses);
  const [completedPasses, setCompletedPasses] = useState(
    initialCompletedPasses,
  );
  const [error, setError] = useState<string | null>(initialError);
  const [generatedAt, setGeneratedAt] = useState<string | null>(
    initialGeneratedAt,
  );
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [markdownLoading, setMarkdownLoading] = useState(false);
  /**
   * B0-571 — the structured read of the same report the Markdown endpoint renders. The Markdown is
   * still fetched and held above, unchanged: B0-592 requires Copy markdown / Download .md to stay
   * byte-identical, so this is an ADDITIONAL read path, not a replacement for it.
   */
  const [reportData, setReportData] = useState<ReportDataReady | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [copyLabel, setCopyLabel] = useState('Copy');
  const [needsManualContinue, setNeedsManualContinue] = useState(false);

  const inFlightRef = useRef(false);
  const continueAttemptsRef = useRef(0);
  const contentRef = useRef<HTMLDivElement>(null);

  const reportComponents = useMemo(
    () => ({ a: ReportAnchorLink, blockquote: ReportCaseQuote }),
    [],
  );

  const reportSections = useMemo(
    () => (markdown ? splitReportMarkdown(markdown) : null),
    [markdown],
  );

  const post = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setNeedsManualContinue(false);
    setStatus((current) => (current === 'idle' ? 'scoring' : current));

    try {
      const res = await fetch(`/api/admin/tests/runs/${runId}/report`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => ({}))) as ReportStatusResponse;
      inFlightRef.current = false;

      if (!res.ok) {
        setError(data.error ?? 'Failed to generate report.');
        setStatus('failed');
        return;
      }

      const nextStatus = data.status ?? 'failed';
      setStatus(nextStatus);
      setTotalCases(data.totalCases ?? totalCases);
      setCompletedCases(data.completedCases ?? completedCases);
      setPasses(data.passes ?? passes);
      setCompletedPasses(data.completedPasses ?? completedPasses);
      setError(data.error ?? null);

      if (nextStatus === 'scoring' || nextStatus === 'synthesizing') {
        if (continueAttemptsRef.current < MAX_AUTO_CONTINUES) {
          continueAttemptsRef.current += 1;
          void post();
        } else {
          setNeedsManualContinue(true);
        }
      }
    } catch {
      inFlightRef.current = false;
      setError('Network error while generating the report.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const retryFromScratch = useCallback(() => {
    continueAttemptsRef.current = 0;
    void post();
  }, [post]);

  // Drive generation forward once on mount if it isn't already finished — covers both a fresh
  // "idle" report and resuming a "scoring"/"synthesizing" one left mid-flight by a prior request.
  useEffect(() => {
    if (isRunCompleted && !isTerminal(initialStatus)) {
      void post();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll independently of the in-flight POST so the progress bar reflects checkpoint writes as
  // they happen, mirroring RunExecutionProgress's poll loop.
  useEffect(() => {
    if (!isRunCompleted || isTerminal(status)) return;

    const poll = async () => {
      try {
        const res = await fetch(`/api/admin/tests/runs/${runId}/report`, {
          method: 'GET',
          cache: 'no-store',
        });
        if (!res.ok) return;
        const data = (await res.json()) as ReportStatusResponse;
        if (data.status) setStatus(data.status);
        if (typeof data.totalCases === 'number') setTotalCases(data.totalCases);
        if (typeof data.completedCases === 'number')
          setCompletedCases(data.completedCases);
        if (typeof data.passes === 'number') setPasses(data.passes);
        if (typeof data.completedPasses === 'number')
          setCompletedPasses(data.completedPasses);
        if (data.generatedAt !== undefined)
          setGeneratedAt(data.generatedAt ?? null);
        setError(data.error ?? null);
      } catch {
        // keep polling; transient failures are expected during long generation runs.
      }
    };

    void poll();
    const intervalId = window.setInterval(() => void poll(), 5000);
    return () => window.clearInterval(intervalId);
  }, [runId, status, isRunCompleted]);

  // Fetch the rendered Markdown once generation completes.
  useEffect(() => {
    if (status !== 'completed' || markdown || markdownLoading) return;

    let cancelled = false;
    setMarkdownLoading(true);
    fetch(`/api/admin/tests/runs/${runId}/report/markdown`, {
      cache: 'no-store',
    })
      .then((res) => res.json())
      .then(
        (data: {
          ok?: boolean;
          markdown?: string;
          generatedAt?: string | null;
        }) => {
          if (cancelled) return;
          if (data.ok && data.markdown) {
            setMarkdown(data.markdown);
            setGeneratedAt(data.generatedAt ?? null);
          }
        },
      )
      .catch(() => {
        if (!cancelled) setError('Failed to load the generated report.');
      })
      .finally(() => {
        if (!cancelled) setMarkdownLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `markdownLoading` is intentionally omitted: it's set inside this effect, so including it
    // would re-run (and cancel) this same effect the instant the loading flag flips to true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, runId, markdown]);

  // B0-586/B0-571 — structured payload for the verdict-first layout, fetched alongside the Markdown
  // once generation completes. A `not_generated` response leaves `reportData` null and the view
  // simply keeps showing the Markdown fallback below.
  useEffect(() => {
    if (status !== 'completed' || reportData) return;

    let cancelled = false;
    fetch(`/api/admin/tests/runs/${runId}/report/data`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data: { status?: string }) => {
        if (cancelled) return;
        if (data.status === 'ready') setReportData(data as ReportDataReady);
      })
      .catch(() => {
        // Non-fatal: the Markdown render below is the fallback.
      });

    return () => {
      cancelled = true;
    };
  }, [status, runId, reportData]);

  const downloadMarkdown = useCallback(() => {
    if (!markdown) return;
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${sanitizeFilename(fileBase)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [markdown, fileBase]);

  const copyMarkdown = useCallback(async () => {
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
      setCopyLabel('Copied!');
      window.setTimeout(() => setCopyLabel('Copy'), 2000);
    } catch {
      setCopyLabel('Copy failed');
      window.setTimeout(() => setCopyLabel('Copy'), 2000);
    }
  }, [markdown]);

  const downloadPdf = useCallback(async () => {
    const root = contentRef.current;
    if (!root) return;
    setPdfLoading(true);
    /**
     * B0-592 — every disclosure and every collapsed ledger row must appear in the PDF. `html2pdf`
     * rasterises through `html2canvas`, which renders the SCREEN styles, so an `@media print` rule
     * would never fire: the only reliable way to get closed `<details>` into the capture is to open
     * them imperatively first and put them back afterwards. Restoration runs in `finally` so an
     * export that throws mid-render cannot leave the reader's page permanently expanded.
     */
    const disclosures = Array.from(root.querySelectorAll('details'));
    const wasClosed = disclosures.filter((node) => !node.open);
    wasClosed.forEach((node) => {
      node.open = true;
    });
    root.classList.add('report-pdf-capture');

    try {
      const html2pdf = (await import('html2pdf.js')).default;
      await html2pdf()
        .from(root)
        .set({
          filename: `${sanitizeFilename(fileBase)}.pdf`,
          margin: 12,
          image: { type: 'jpeg', quality: 0.95 },
          html2canvas: { scale: 2, useCORS: true },
          jsPDF: { unit: 'pt', format: 'letter', orientation: 'portrait' },
        })
        .save();
    } finally {
      root.classList.remove('report-pdf-capture');
      wasClosed.forEach((node) => {
        node.open = false;
      });
      setPdfLoading(false);
    }
  }, [fileBase]);

  if (!isRunCompleted) {
    return (
      <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-sm text-slate-600">
          This run hasn&apos;t finished yet — reports can only be generated once
          it completes.{' '}
          <Link
            className="font-medium text-sky-700 underline"
            href={`/admin/tests/${testId}/runs/${runId}`}
          >
            Back to run details
          </Link>
        </p>
      </section>
    );
  }

  /**
   * B0-719 — counted in (case, pass) units, never in cases. A 3-pass report that counted cases
   * would show nothing at all until the third pass began and then jump to 100%; this advances
   * through every pass. `passes` is 1 for every report graded before multi-pass grading existed,
   * so this is the same arithmetic it always was for them.
   */
  const totalUnits = totalCases * Math.max(1, passes);
  const progressPercent =
    totalUnits > 0
      ? Math.min(100, Math.round((completedPasses / totalUnits) * 100))
      : 0;

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex flex-col text-center flex-wrap items-center justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
                Evaluation report
              </p>
              {isGolden && (
                <span className="inline-flex items-center rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-semibold text-yellow-900">
                  Golden Set
                </span>
              )}
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
              {testName}
            </h1>
            {generatedAt ? (
              <p className="mt-1 text-xs text-slate-400">
                Generated {new Date(generatedAt).toLocaleString()} - v
                {appVersion}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href={`/admin/tests/${testId}/runs/${runId}`}>Back</Link>
            </Button>
            {status === 'completed' && markdown ? (
              <>
                <Button
                  onClick={() => void copyMarkdown()}
                  size="sm"
                  variant="outline"
                >
                  {copyLabel}
                </Button>
                <Button onClick={downloadMarkdown} size="sm" variant="outline">
                  <Download className="size-4" />
                  Download .md
                </Button>
                <Button
                  disabled={pdfLoading}
                  onClick={() => void downloadPdf()}
                  size="sm"
                  variant="outline"
                >
                  {pdfLoading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <FileDown className="size-4" />
                  )}
                  Download PDF
                </Button>
                <Button
                  disabled={inFlightRef.current}
                  onClick={retryFromScratch}
                  size="sm"
                  variant="outline"
                >
                  <RefreshCw className="size-4" />
                  Regenerate
                </Button>
              </>
            ) : null}
          </div>
        </div>

        {!isTerminal(status) ? (
          <div aria-live="polite" className="mt-6" role="status">
            <p className="text-sm text-slate-600">
              {status === 'synthesizing'
                ? 'Scoring complete — synthesizing failure patterns and recommendations…'
                : `Grading responses: ${completedCases} of ${totalCases || '…'} cases scored${
                    passes > 1
                      ? ` · ${passes} independent passes per case (${completedPasses} of ${totalUnits} gradings done)`
                      : ''
                  }`}
            </p>
            <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-sky-600 transition-[width] duration-300"
                style={{
                  width: `${status === 'synthesizing' ? 100 : progressPercent}%`,
                }}
              />
            </div>
            {needsManualContinue ? (
              <Button
                className="mt-4"
                onClick={retryFromScratch}
                size="sm"
                variant="outline"
              >
                Continue generating
              </Button>
            ) : null}
          </div>
        ) : null}

        {status === 'failed' && error ? (
          /**
           * B0-714 — two failures that look identical in a log but are nothing alike to a reader.
           * A structural invariant failure means the numbers did not reconcile and the report was
           * deliberately refused: retrying the same data will refuse it again, so the panel says
           * what failed and points at the data instead of leading with a Retry button. Everything
           * else (OpenAI, the network, a timeout) is transient and Retry is the right first move.
           */
          isInvariantErrorMessage(error) ? (
            <div className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              <p className="font-semibold">
                Report refused — the run&apos;s numbers did not reconcile
              </p>
              <p className="mt-1">
                A consistency check failed while computing the metrics, so no
                report was written. This is a problem with the run&apos;s data,
                not a transient error — regenerating will fail the same way
                until it is fixed.
              </p>
              <p className="mt-2 font-mono text-xs break-words whitespace-pre-wrap">
                {error}
              </p>
              <Button
                className="mt-3 block"
                onClick={retryFromScratch}
                size="sm"
                variant="outline"
              >
                Regenerate anyway
              </Button>
            </div>
          ) : (
            <div className="mt-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              {error}
              <Button
                className="mt-3 block"
                onClick={retryFromScratch}
                size="sm"
                variant="outline"
              >
                Retry
              </Button>
            </div>
          )
        ) : null}
      </section>

      {status === 'completed' &&
      !reportData &&
      (markdownLoading || !markdown) ? (
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-sm text-slate-500">Loading report…</p>
        </section>
      ) : null}

      {reportData ? (
        <div className="flex flex-col gap-6" ref={contentRef}>
          {/* B0-592 — the capture class keeps segmented bars readable when the PDF renderer drops
              background colours, and drives pagination: html2pdf's default pagebreak mode honours
              these CSS rules, so a case record is never split and each major section starts a page. */}
          <style>{`
            .report-pdf-capture [data-report-bar-segment] { outline: 1px solid rgba(15,23,42,.35); }
            .report-pdf-capture [data-report-case] { break-inside: avoid; page-break-inside: avoid; }
            .report-pdf-capture [data-report-section] { break-before: page; page-break-before: always; }
            .report-pdf-capture [data-report-section]:first-of-type { break-before: auto; page-break-before: auto; }
          `}</style>

          {/* B0-1014 — first of all: a refused run has nothing to grade, so it outranks B0-911. */}
          <ProviderFaultBanner health={providerHealth} />

          {/* B0-911 — first, and above the grade, by design. */}
          <DegradedRunBanner health={routingHealth} />

          <ReportVerdictStrip
            cases={reportData.cases}
            metrics={reportData.metrics}
          />

          <div data-report-section>
            <ReportBreakdownCards
              categories={reportData.metrics.categories}
              speed={reportData.metrics.speed}
              strongestCategory={reportData.metrics.strongestCategory}
              tiers={reportData.metrics.tiers}
              totalCases={reportData.metrics.totalCases}
              weakestCategory={reportData.metrics.weakestCategory}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-3" data-report-section>
            <div className="lg:col-span-2">
              <ReportTopFixes
                metrics={reportData.metrics}
                synthesis={reportData.synthesis}
              />
            </div>
            <ReportExecutiveAssessment synthesis={reportData.synthesis} />
          </div>

          <div data-report-section>
            <ReportCaseLedger
              canDownloadTrace={canDownloadTrace}
              cases={reportData.cases}
              metrics={reportData.metrics}
            />
          </div>

          <div data-report-section>
            <ReportAggregateFindings
              metrics={reportData.metrics}
              synthesis={reportData.synthesis}
            />
          </div>

          <div data-report-section>
            <ReportMethodology
              answeringModel={answeringModel}
              answeringProvider={answeringProvider}
              answeringRuntime={answeringRuntime}
              config={reportData.config}
              passMark={reportData.metrics.passMark}
              // B0-835 — the concept rules this report's numbers were derived under.
              scoringRules={reportData.metrics.scoringRules}
              strictPassMark={reportData.metrics.strictPassMark}
              uteCount={reportData.metrics.uteCount}
            />
          </div>
        </div>
      ) : null}

      {/* Fallback: a report generated before the structured endpoint existed, or a payload that
          failed to load. The Markdown render is unchanged from before the restructure. */}
      {!reportData && markdown && reportSections ? (
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div ref={contentRef}>
            <BexStreamdown
              components={reportComponents}
              content={reportSections.before}
              isStreaming={false}
              isUser={false}
            />
            {reportSections.cases.map((caseMarkdown, index) => (
              <div
                className={cn('px-3 py-8', CASE_TONE_CLASSES[index % 2])}
                key={index}
              >
                <BexStreamdown
                  components={reportComponents}
                  content={caseMarkdown}
                  isStreaming={false}
                  isUser={false}
                />
              </div>
            ))}
            <BexStreamdown
              components={reportComponents}
              content={reportSections.after}
              isStreaming={false}
              isUser={false}
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}
