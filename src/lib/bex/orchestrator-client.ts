import {
  bexOrchestrateOkResponseSchema,
  type OrchestrationRunResult,
} from '~/lib/orchestrator/orchestrator-schemas';

export type BexOrchestrateResponse = { ok: true } & OrchestrationRunResult;

export function formatOrchestratorReply(payload: OrchestrationRunResult): string {
  const lines: string[] = [
    `**Workflow:** ${payload.workflow}`,
    '',
  ];

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

    if (payload.sme.focusAreas.length > 0) {
      lines.push('**SME focus (stub)**');
      for (const area of payload.sme.focusAreas) {
        lines.push(`- ${area}`);
      }
      lines.push('');
    }

    if (payload.sme.sessionContextGuide.length > 0) {
      lines.push('**Recommended session `context` keys**');
      for (const line of payload.sme.sessionContextGuide) {
        lines.push(`- ${line}`);
      }
      lines.push('');
    }

    lines.push(
      '**SME system prompt**',
      '```text',
      payload.sme.systemPrompt,
      '```',
      '',
    );
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
              sessionContextGuide: payload.sme.sessionContextGuide,
              systemPrompt: payload.sme.systemPrompt,
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
