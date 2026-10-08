'use client';

import { Braces, Copy, Download, FileDown, Loader2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '~/components/ui/button';
import {
  sanitizeFilename,
  thursdayScorecardFileBaseFor,
} from '~/lib/tests/thursday-scorecard-export';

/**
 * B0-1168 — the scorecard's export toolbar: Copy markdown, Download .md, Download PDF, Download
 * JSON. Markdown and JSON are fetched on click from `/api/admin/tests/reports/thursday-scorecard`,
 * which renders the same snapshot the table was built from; the PDF is a capture of the table's
 * own DOM. Rendered OUTSIDE the capture root so the toolbar is never in the PDF.
 */
export type ThursdayScorecardExportsProps = {
  /** The sweep on screen; `null` when no Thursday-night sweep exists (every control disabled). */
  sweepId: string | null;
  /** `snapshot.sweep.sweepTriggeredAt` — names the JSON file by its Eastern date. */
  sweepTriggeredAt: string | null;
  /** `snapshot.agents.length > 0`; nothing to export otherwise. */
  hasRows: boolean;
  /** DOM id of the element to rasterise into the PDF (`thursday-scorecard-capture`). */
  captureTargetId: string;
};

const EXPORT_ROUTE = '/api/admin/tests/reports/thursday-scorecard';

/** Added to the capture root for the duration of a PDF capture (see the `<style>` below). */
const PDF_CAPTURE_CLASS = 'scorecard-pdf-capture';

type MarkdownExportBody = { ok: true; markdown: string; fileBase: string };

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `Export failed (HTTP ${response.status})`;
}

export function ThursdayScorecardExports({
  sweepId,
  sweepTriggeredAt,
  hasRows,
  captureTargetId,
}: ThursdayScorecardExportsProps) {
  const [copyLabel, setCopyLabel] = useState('Copy markdown');
  const [markdownBusy, setMarkdownBusy] = useState(false);
  const [jsonBusy, setJsonBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);

  const disabled = !hasRows || !sweepId;

  const fetchMarkdown = useCallback(async (): Promise<MarkdownExportBody | null> => {
    if (!sweepId) return null;
    const params = new URLSearchParams({ sweepId, format: 'markdown' });
    const response = await fetch(`${EXPORT_ROUTE}?${params}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as MarkdownExportBody;
  }, [sweepId]);

  const copyMarkdown = useCallback(async () => {
    setMarkdownBusy(true);
    try {
      const body = await fetchMarkdown();
      if (!body) return;
      await navigator.clipboard.writeText(body.markdown);
      setCopyLabel('Copied!');
    } catch (error) {
      setCopyLabel('Copy failed');
      toast.error(error instanceof Error ? error.message : 'Copy failed');
    } finally {
      setMarkdownBusy(false);
      window.setTimeout(() => setCopyLabel('Copy markdown'), 2000);
    }
  }, [fetchMarkdown]);

  const downloadMarkdown = useCallback(async () => {
    setMarkdownBusy(true);
    try {
      const body = await fetchMarkdown();
      if (!body) return;
      triggerDownload(
        new Blob([body.markdown], { type: 'text/markdown' }),
        `${sanitizeFilename(body.fileBase)}.md`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Download failed');
    } finally {
      setMarkdownBusy(false);
    }
  }, [fetchMarkdown]);

  const downloadJson = useCallback(async () => {
    if (!sweepId) return;
    setJsonBusy(true);
    try {
      const params = new URLSearchParams({ sweepId, format: 'json' });
      const response = await fetch(`${EXPORT_ROUTE}?${params}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(await readError(response));
      const body: unknown = await response.json();
      const fileBase = sanitizeFilename(
        thursdayScorecardFileBaseFor(sweepTriggeredAt ?? new Date().toISOString()),
      );
      triggerDownload(
        new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }),
        `${fileBase}.json`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Download failed');
    } finally {
      setJsonBusy(false);
    }
  }, [sweepId, sweepTriggeredAt]);

  const downloadPdf = useCallback(async () => {
    const root = document.getElementById(captureTargetId);
    if (!root || !sweepTriggeredAt) {
      toast.error('Nothing to capture.');
      return;
    }
    setPdfBusy(true);
    root.classList.add(PDF_CAPTURE_CLASS);
    try {
      const html2pdf = (await import('html2pdf.js')).default;
      await html2pdf()
        .from(root)
        .set({
          filename: `${sanitizeFilename(thursdayScorecardFileBaseFor(sweepTriggeredAt))}.pdf`,
          margin: 12,
          image: { type: 'jpeg', quality: 0.95 },
          // `windowWidth` = the root's full scroll width so the wide table is not clipped to the viewport.
          html2canvas: { scale: 2, useCORS: true, windowWidth: root.scrollWidth },
          jsPDF: { unit: 'pt', format: 'letter', orientation: 'landscape' },
        })
        .save();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'PDF export failed');
    } finally {
      root.classList.remove(PDF_CAPTURE_CLASS);
      setPdfBusy(false);
    }
  }, [captureTargetId, sweepTriggeredAt]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* html2canvas renders screen styles, so the scroll clamp must be lifted on the live DOM for the capture. */}
      <style>{`.${PDF_CAPTURE_CLASS} .scorecard-scroll { max-height: none !important; overflow: visible !important; }`}</style>
      <Button
        disabled={disabled || markdownBusy}
        onClick={() => void copyMarkdown()}
        size="sm"
        variant="outline"
      >
        <Copy className="size-4" />
        {copyLabel}
      </Button>
      <Button
        disabled={disabled || markdownBusy}
        onClick={() => void downloadMarkdown()}
        size="sm"
        variant="outline"
      >
        <Download className="size-4" />
        Download .md
      </Button>
      <Button
        disabled={disabled || pdfBusy}
        onClick={() => void downloadPdf()}
        size="sm"
        variant="outline"
      >
        {pdfBusy ? <Loader2 className="size-4 animate-spin" /> : <FileDown className="size-4" />}
        Download PDF
      </Button>
      <Button
        disabled={disabled || jsonBusy}
        onClick={() => void downloadJson()}
        size="sm"
        variant="outline"
      >
        <Braces className="size-4" />
        Download JSON
      </Button>
    </div>
  );
}
