'use client';

import { Download } from 'lucide-react';
import { useCallback } from 'react';

import { Button } from '~/components/ui/button';
import type { RetrievedDocumentChunkRef } from '~/lib/workflows/product-support/product-support-schemas';

/**
 * Full-fidelity run export: every field captured for a run, not just what's
 * rendered in the item-level results table. Includes the raw `response_payload`
 * so nothing is lost to formatting.
 */
export type RunExportItem = {
  row_index: number;
  test_item_id: string;
  prompt: string;
  /** Item priority rank (lower = more important); null when unset. */
  priority: number | null;
  /**
   * B0-853 — the category of record: the dataset's human-authored `question_category`, falling
   * back to the classifier's `prompt_category`, else `Uncategorized`. The same label the run report
   * groups by and the grader was shown (`resolveReportCategory`).
   */
  category: string;
  passed: boolean;
  status: string;
  similarity: number | null;
  confidence: number | null;
  /** B0-492 — which mechanism produced `confidence` ('unknown' for a pre-B0-492 payload). */
  confidence_provenance: string;
  elapsed_ms: number;
  /** B0-850 — harness time-to-first-token, in milliseconds; null when not recorded. */
  ttft_ms: number | null;
  model: string | null;
  agent: string | null;
  response_text: string | null;
  error_message: string | null;
  /** Gold-standard answer for this item; null when unset. */
  ideal_response: string | null;
  /**
   * B0-933 — golden-set expectations. The underlying columns are arrays; they are emitted as
   * pipe-delimited cells (`a | b`) so an export round-trips through the CSV importer. Phrases are
   * verbatim as authored — never rounded, unit-converted, re-cased or truncated. Empty when unset.
   */
  expected_concepts: string;
  minimum_concepts: string;
  /** Pipe-delimited `rag.document.id` uuids, in author order. */
  expected_sources: string;
  should_cite: boolean | null;
  timing: {
    toolRounds: number;
    cacheSource: string | null;
    searchMs: number | null;
  } | null;
  retrieved_document_chunks: RetrievedDocumentChunkRef[];
  response_payload: unknown;
  created_at: string;
};

export type RunExportData = {
  run: {
    id: string;
    test_id: string;
    test_name: string;
    status: string;
    started_at: string | null;
    created_at: string;
    elapsed_ms: number | null;
    total_items: number;
    passed_items: number;
    failed_items: number;
    notes: string | null;
    /** B0-351 — the run's immutable `run_options` config (model / validator / agent mode / router). */
    run_config: {
      model_tag: string | null;
      use_validator: boolean;
      agent_mode: string;
      router_type: string | null;
    };
  };
  items: RunExportItem[];
};

function sanitizeExportFilename(name: string): string {
  const trimmed = name.trim() || 'run-export';
  return trimmed.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 100);
}

type RunFullExportDownloadProps = {
  data: RunExportData;
  /** Used for `{fileBase}.json` */
  fileBase: string;
};

export function RunFullExportDownload({
  data,
  fileBase,
}: RunFullExportDownloadProps) {
  const downloadJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${sanitizeExportFilename(fileBase)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [data, fileBase]);

  return (
    <Button onClick={downloadJson} size="sm" type="button" variant="outline">
      <Download className="size-4" />
      Export
    </Button>
  );
}
