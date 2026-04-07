import type { OrchestrationRunResult } from '~/lib/orchestrator/run-orchestration';

export type BexOrchestrateResponse = { ok: true } & OrchestrationRunResult;

export function formatOrchestratorReply(payload: OrchestrationRunResult): string {
  const lines: string[] = [
    `**Workflow:** ${payload.workflow}`,
    '',
  ];

  if (payload.routing) {
    lines.push(
      '**Orchestrator routing**',
      `- **Decision:** \`${payload.routing.decision}\``,
      `- **Scores:** product ${payload.routing.productScore} · bathroom ${payload.routing.bathroomScore}`,
      `- **Rationale:** ${payload.routing.rationale}`,
      '',
    );
  }

  if (payload.sme) {
    lines.push(`### ${payload.sme.label}`, '', payload.sme.acknowledgement, '');

    if (payload.sme.focusAreas.length > 0) {
      lines.push('**SME focus (stub)**');
      for (const area of payload.sme.focusAreas) {
        lines.push(`- ${area}`);
      }
      lines.push('');
    }
  }

  lines.push('**Steps**');

  for (const step of payload.steps) {
    const suffix =
      'note' in step && step.note ? ` — ${step.note}` : '';
    lines.push(`- **${step.id}** (${step.status})${suffix}`);
  }

  lines.push(
    '',
    '```json',
    JSON.stringify(
      {
        input: payload.input,
        routing: payload.routing,
        sme: payload.sme
          ? {
              agent: payload.sme.agent,
              label: payload.sme.label,
              focusAreas: payload.sme.focusAreas,
              smeSteps: payload.sme.steps,
            }
          : undefined,
        steps: payload.steps,
      },
      null,
      2,
    ),
    '```',
  );

  return lines.join('\n');
}

export async function callBexOrchestrate(options: {
  message: string;
  model: string;
  workflow?: string;
}): Promise<string> {
  const res = await fetch('/api/v1/orchestrator', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: options.message,
      model: options.model,
      workflow: options.workflow ?? 'bex-chat',
    }),
  });

  const data = (await res.json()) as
    | BexOrchestrateResponse
    | { error?: string };

  if (!res.ok) {
    throw new Error(
      typeof data === 'object' && data && 'error' in data && data.error
        ? String(data.error)
        : `Orchestrator request failed (${res.status})`,
    );
  }

  if (
    !('ok' in data) ||
    !data.ok ||
    !('workflow' in data) ||
    !('steps' in data) ||
    !('input' in data)
  ) {
    throw new Error('Unexpected response from orchestrator');
  }

  return formatOrchestratorReply({
    workflow: data.workflow,
    input: data.input,
    steps: data.steps,
  });
}
