'use client';

import { Download } from 'lucide-react';
import { useCallback } from 'react';

import { Button } from '~/components/ui/button';

export type RunResultCsvRow = {
  row_index: number;
  prompt: string;
  expected_should_answer: string;
  passed: boolean;
  elapsed_seconds: number;
  status: string;
  model: string;
  timing_breakdown: string;
  /** Encoded semantic hits: `document_uuid|chunk_uuid` pairs joined by `; `. */
  retrieved_chunks: string;
  message: string;
  test_item_id: string;
};

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function sanitizeCsvFilename(name: string): string {
  const trimmed = name.trim() || 'run-results';
  return trimmed.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 100);
}

type RunItemResultsCsvDownloadProps = {
  rows: RunResultCsvRow[];
  /** Used for `{fileBase}.csv` */
  fileBase: string;
};

export function RunItemResultsCsvDownload({
  rows,
  fileBase,
}: RunItemResultsCsvDownloadProps) {
  const downloadCsv = useCallback(() => {
    if (rows.length === 0) {
      return;
    }

    const headers = [
      'row_index',
      'prompt',
      'expected_should_answer',
      'passed',
      'elapsed_seconds',
      'status',
      'model',
      'timing_breakdown',
      'retrieved_chunks',
      'message',
      'test_item_id',
    ];

    const lines = [
      headers.join(','),
      ...rows.map((row) =>
        [
          String(row.row_index),
          row.prompt,
          row.expected_should_answer,
          row.passed ? 'yes' : 'no',
          String(row.elapsed_seconds),
          row.status,
          row.model,
          row.timing_breakdown,
          row.retrieved_chunks,
          row.message,
          row.test_item_id,
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
    anchor.download = `${sanitizeCsvFilename(fileBase)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [fileBase, rows]);

  return (
    <Button
      aria-label="Download item-level results as CSV"
      className="size-9 shrink-0 rounded-2xl"
      disabled={rows.length === 0}
      onClick={downloadCsv}
      size="icon"
      type="button"
      variant="outline"
    >
      <Download className="size-4" />
    </Button>
  );
}
