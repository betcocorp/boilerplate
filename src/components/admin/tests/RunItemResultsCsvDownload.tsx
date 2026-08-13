'use client';

import { Download } from 'lucide-react';
import { useCallback } from 'react';

import { Button } from '~/components/ui/button';

/**
 * Item-level run export: columns match the “Item-level results” table on the run page
 * (row order, labels, and formatted values).
 */
export type RunResultCsvRow = {
  row_index: number;
  prompt: string;
  /** Formatted item priority (lower = more important); empty when unset. */
  priority: string;
  /** Table “Answer?” — `Unset` / `Yes` / `No`. */
  expected_answer: string;
  /** Table “Passed” — `Yes` / `No`. */
  passed: string;
  /** Table “Sim / conf”. */
  sim_conf: string;
  /** Table “Elapsed” — e.g. `24.94 s` (same as `formatDurationSeconds`). */
  elapsed: string;
  model: string;
  /** Table “Agent” — routed SME agent (product/bathroom/dilution/floor), or “n/a”. */
  agent: string;
  /** Table “Rounds | Cache | …” workflow timing string. */
  rounds_cache_search: string;
  message: string;
  /** Gold-standard answer for this item; empty when unset. */
  ideal_response: string;
  /** Golden-set expectations, verbatim as authored; empty when unset. */
  expected_concepts: string;
  minimum_concepts: string;
  expected_sources: string;
  /** `yes` / `no` / empty when unset. */
  should_cite: string;
  /** Table “History” View link path. */
  item_detail_path: string;
  /** Encoded semantic hits: `document_id|chunk_id` pairs joined by `; ` (Docs dialog). */
  retrieved_chunks: string;
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
      'priority',
      'expected_answer',
      'passed',
      'sim_conf',
      'elapsed',
      'model',
      'agent',
      'rounds_cache_search',
      'message',
      'ideal_response',
      'expected_concepts',
      'minimum_concepts',
      'expected_sources',
      'should_cite',
      'item_detail_path',
      'retrieved_chunks',
      'test_item_id',
    ];

    const lines = [
      headers.join(','),
      ...rows.map((row) =>
        [
          String(row.row_index),
          row.prompt,
          row.priority,
          row.expected_answer,
          row.passed,
          row.sim_conf,
          row.elapsed,
          row.model,
          row.agent,
          row.rounds_cache_search,
          row.message,
          row.ideal_response,
          row.expected_concepts,
          row.minimum_concepts,
          row.expected_sources,
          row.should_cite,
          row.item_detail_path,
          row.retrieved_chunks,
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
