import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { RecommendationTracePanel } from '~/components/admin/RecommendationTracePanel';
import { Button } from '~/components/ui/button';
import { getRecommendation } from '~/lib/recommendations/repository';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

export const metadata = {
  title: 'Cross-reference · Recommendation trace | Betco BEX Admin',
  description:
    'Full evidence trace for one web-grounded cross-reference recommendation: web search results, scoring, validation, timing, and spec.',
};

type PageProps = {
  params: Promise<{ id: string }>;
};

/**
 * B0-1055 — best-effort secondary link to the full chat workflow trace. Most rows on this queue
 * come from the eval harness's SME-agent-direct path or the admin tester route, neither of which
 * produces a `workflow_runs` row for `evidence.traceId` — only the full interactive chat workflow
 * does. Never throws; a miss (the common case) just means the link is omitted.
 */
async function findMatchingWorkflowRunId(traceId: string | null): Promise<string | null> {
  if (!traceId) return null;
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('workflow_runs')
      .select('id')
      .eq('id', traceId)
      .maybeSingle();
    if (error || !data) return null;
    return data.id;
  } catch {
    return null;
  }
}

export default async function RecommendationTracePage({ params }: PageProps) {
  const { id } = await params;
  const recommendation = await getRecommendation(id);
  if (!recommendation) notFound();

  const normalizedInput = recommendation.normalizedInput as { traceId?: string | null } | null;
  const evidence = recommendation.evidence as { traceId?: string | null } | null;
  const traceId = evidence?.traceId ?? normalizedInput?.traceId ?? null;
  const matchingWorkflowRunId = await findMatchingWorkflowRunId(traceId);

  return (
    <div className="space-y-4">
      <Button asChild className="h-auto p-0" size="sm" variant="link">
        <Link href="/admin/tools/cross-reference/recommendations">
          <ArrowLeft className="mr-1 size-3.5" />
          Back to recommendation queue
        </Link>
      </Button>

      <RecommendationTracePanel
        matchingWorkflowRunId={matchingWorkflowRunId}
        recommendation={recommendation}
      />
    </div>
  );
}
