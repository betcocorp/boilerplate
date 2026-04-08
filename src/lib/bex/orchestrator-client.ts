import {
  bexOrchestrateOkResponseSchema,
  type OrchestrationRunResult,
} from '~/lib/orchestrator/orchestrator-schemas';

export type BexOrchestrateResponse = { ok: true } & OrchestrationRunResult;

export function formatOrchestratorReply(payload: OrchestrationRunResult): string {
  if (payload.productSupport) {
    const p = payload.productSupport;
    const lines = [
      p.answerText,
      '',
      `**Confidence:** ${p.confidence ?? 'n/a'}`,
      `**Validator:** ${p.validation.approved ? 'approved' : 'not approved'}${p.validation.requires_human_review ? ' · human review' : ''}`,
    ];

    if (p.validation.issues.length > 0) {
      lines.push('', '**Validator issues**');
      for (const issue of p.validation.issues) {
        lines.push(`- ${issue}`);
      }
    }

    if (p.sources && p.sources.length > 0) {
      lines.push('', '**Sources**');
      for (const s of p.sources.slice(0, 12)) {
        lines.push(`- \`${s.documentId}\` — ${s.title}`);
      }
    }

    lines.push(
      '',
      `**Conversation:** \`${p.conversationId}\` · **Run:** \`${p.workflowRunId}\` · **Response:** \`${p.latestOpenaiResponseId}\``,
    );

    return lines.join('\n');
  }

  const lines: string[] = [`**Workflow:** ${payload.workflow}`, ''];

  if (payload.routing) {
    const r = payload.routing;
    lines.push(
      '**Orchestrator routing**',
      `- **Decision:** \`${r.decision}\``,
      `- **Scores:** product ${r.productScore} · bathroom ${r.bathroomScore} · dilution ${r.dilutionScore} · floor ${r.floorScore}`,
      `- **Rationale:** ${r.rationale}`,
      '',
    );
  }

  if (payload.sme) {
    lines.push(`### ${payload.sme.label}`, '', payload.sme.acknowledgement, '');
  }

  lines.push('**Steps**');
  for (const step of payload.steps) {
    const suffix = 'note' in step && step.note ? ` — ${step.note}` : '';
    lines.push(`- **${step.id}** (${step.status})${suffix}`);
  }

  return lines.join('\n');
}

export async function callBexOrchestrate(options: {
  message: string;
  model: string;
  workflow?: string;
  conversationId?: string;
}): Promise<string> {
  const res = await fetch('/api/v1/orchestrator', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: options.message,
      model: options.model,
      workflow: options.workflow ?? 'bex-chat',
      ...(options.conversationId
        ? { conversationId: options.conversationId }
        : {}),
    }),
  });

  const data: unknown = await res.json();

  if (!res.ok) {
    const err =
      data &&
      typeof data === 'object' &&
      'error' in data &&
      typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `Orchestrator request failed (${res.status})`;
    throw new Error(err);
  }

  const parsed = bexOrchestrateOkResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error('Unexpected response from orchestrator');
  }

  return formatOrchestratorReply(parsed.data);
}
