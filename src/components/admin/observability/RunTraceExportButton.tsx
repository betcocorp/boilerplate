'use client';

import { Download, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { useRunInsights } from '~/components/admin/observability/run-insights-context';
import { Button } from '~/components/ui/button';

/**
 * Downloads the whole run as one JSON file: the raw `workflow_runs` /
 * `workflow_steps` / `audit_logs` rows plus the assembled timeline (from
 * `/api/admin/observability/runs/[runId]/export`), with any prompt insights
 * generated in this tab merged in.
 *
 * Fetched on click rather than passed as props so the page's RSC payload does
 * not have to carry the full audit trail and untruncated step output.
 */

type Props = {
  runId: string;
};

function sanitizeFilename(name: string): string {
  return (name.trim() || 'run-trace').replace(/[/\\?%*:|"<>]/g, '-').slice(0, 100);
}

export function RunTraceExportButton({ runId }: Props) {
  const { insights, generatedAt } = useRunInsights();
  const [loading, setLoading] = useState(false);

  async function download() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/observability/runs/${runId}/export`);
      const data = (await res.json()) as Record<string, unknown> & { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? 'Export failed.');
        return;
      }

      const payload = {
        ...data,
        promptInsights: insights ? { generatedAt, insights } : null,
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${sanitizeFilename(`run-trace-${runId}`)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button disabled={loading} onClick={download} size="sm" type="button" variant="outline">
      {loading ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Download className="size-4" />
      )}
      Download JSON
    </Button>
  );
}
