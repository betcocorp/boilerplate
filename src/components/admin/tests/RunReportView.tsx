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
import { BexStreamdown } from '~/components/bex/BexStreamdown';
import { Button } from '~/components/ui/button';
import { caseAnchorId } from '~/lib/tests/report/render';

/** Matches the leading UUID in a "Detailed results — case by case" heading (`${id} — ${question}`). */
const CASE_HEADING_ID_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s)/i;

function reactNodeToText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(reactNodeToText).join('');
  if (isValidElement(node)) {
    return reactNodeToText((node.props as { children?: ReactNode }).children);
  }
  return '';
}

/** Gives each "Detailed results" case heading a stable anchor id, matched by `linkifyCaseIds`. */
function ReportCaseHeading({ children, ...rest }: ComponentProps<'h3'>) {
  const match = CASE_HEADING_ID_PATTERN.exec(reactNodeToText(children));
  return (
    <h3 id={match ? caseAnchorId(match[1]) : undefined} {...rest}>
      {children}
    </h3>
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
  initialError: string | null;
  initialGeneratedAt: string | null;
  isRunCompleted: boolean;
};

export function RunReportView({
  runId,
  testId,
  testName,
  fileBase,
  initialStatus,
  initialTotalCases,
  initialCompletedCases,
  initialError,
  initialGeneratedAt,
  isRunCompleted,
}: RunReportViewProps) {
  const [status, setStatus] = useState<ReportStatus>(initialStatus);
  const [totalCases, setTotalCases] = useState(initialTotalCases);
  const [completedCases, setCompletedCases] = useState(initialCompletedCases);
  const [error, setError] = useState<string | null>(initialError);
  const [generatedAt, setGeneratedAt] = useState<string | null>(
    initialGeneratedAt,
  );
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [markdownLoading, setMarkdownLoading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [copyLabel, setCopyLabel] = useState('Copy markdown');
  const [needsManualContinue, setNeedsManualContinue] = useState(false);

  const inFlightRef = useRef(false);
  const continueAttemptsRef = useRef(0);
  const contentRef = useRef<HTMLDivElement>(null);

  const reportComponents = useMemo(
    () => ({ a: ReportAnchorLink, h3: ReportCaseHeading }),
    [],
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
      window.setTimeout(() => setCopyLabel('Copy markdown'), 2000);
    } catch {
      setCopyLabel('Copy failed');
      window.setTimeout(() => setCopyLabel('Copy markdown'), 2000);
    }
  }, [markdown]);

  const downloadPdf = useCallback(async () => {
    if (!contentRef.current) return;
    setPdfLoading(true);
    try {
      const html2pdf = (await import('html2pdf.js')).default;
      await html2pdf()
        .from(contentRef.current)
        .set({
          filename: `${sanitizeFilename(fileBase)}.pdf`,
          margin: 12,
          image: { type: 'jpeg', quality: 0.95 },
          html2canvas: { scale: 2, useCORS: true },
          jsPDF: { unit: 'pt', format: 'letter', orientation: 'portrait' },
        })
        .save();
    } finally {
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

  const progressPercent =
    totalCases > 0
      ? Math.min(100, Math.round((completedCases / totalCases) * 100))
      : 0;

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
              Agent evaluation report
            </p>
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
              <Link href={`/admin/tests/${testId}/runs/${runId}`}>
                Back to run
              </Link>
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
                : `Grading responses: ${completedCases} of ${totalCases || '…'} cases scored`}
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
        ) : null}
      </section>

      {status === 'completed' && (markdownLoading || !markdown) ? (
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-sm text-slate-500">Loading report…</p>
        </section>
      ) : null}

      {markdown ? (
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div ref={contentRef}>
            <BexStreamdown
              components={reportComponents}
              content={markdown}
              isStreaming={false}
              isUser={false}
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}
