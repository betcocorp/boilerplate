import { getOpenAIClient, resolveResponsesModel } from '~/lib/openai/client';
import { extractAssistantText } from '~/lib/openai/response-item-parsing';

import type { EvaluatedCase, RateBlock, ReportMetrics } from './metrics';
import { reportSynthesisSchema, type ReportSynthesis } from './schemas';

/**
 * Strict json_schema for the Top-3 synthesis call (B0-453), hand-mirrored from
 * `reportSynthesisSchema`. `top3` is instructed (not schema-enforced) to be exactly 3 entries —
 * strict mode doesn't support `minItems`/`maxItems` — and validated by Zod after parsing.
 */
const SYNTHESIS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    failurePatterns: { type: 'array', items: { type: 'string' } },
    strengths: { type: 'array', items: { type: 'string' } },
    weaknesses: { type: 'array', items: { type: 'string' } },
    top3: {
      type: 'array',
      description: 'Exactly 3 entries, ranked priority 1 (most important) to 3.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          priority: { type: 'integer' },
          what: { type: 'string' },
          whyFirst: { type: 'string' },
          evidence: { type: 'string' },
          affected: { type: 'string' },
          change: { type: 'string' },
          impact: { type: 'string' },
        },
        required: [
          'priority',
          'what',
          'whyFirst',
          'evidence',
          'affected',
          'change',
          'impact',
        ],
      },
    },
    exec: {
      type: 'object',
      additionalProperties: false,
      properties: {
        strongestAreas: { type: 'array', items: { type: 'string' } },
        improvementAreas: { type: 'array', items: { type: 'string' } },
        mostSignificantFailure: { type: 'string' },
        majorRisk: { type: 'string' },
        readiness: { type: 'string' },
      },
      required: [
        'strongestAreas',
        'improvementAreas',
        'mostSignificantFailure',
        'majorRisk',
        'readiness',
      ],
    },
  },
  required: ['failurePatterns', 'strengths', 'weaknesses', 'top3', 'exec'],
} as const;

const SYNTHESIS_SYSTEM_PROMPT = `You are synthesizing findings across a full agent-evaluation run, following Betco's internal agent-evaluation methodology.

Identify the most common failure patterns (cite case IDs), key strengths (cite case IDs), and recurring weaknesses (cite case IDs) across the cases provided.

Then produce exactly 3 "Top 3 recommended agent improvements", ranked Priority #1 (most important) to #3, by: frequency of the problem, severity, business impact, impact on Tier 1 (highest-priority) cases, weak categories, likely effect on the overall score, and whether the issue is systemic rather than isolated. Answer: "If we could fix only three things before testing this agent again, what should they be?" Keep recommendations about the AGENT (its instructions/system prompt, retrieval behavior, grounding against sources, knowledge gaps, response logic, handling of specific question types, completeness, hallucination/unsupported content, intent understanding) — not about the testing process, unless something about the test data itself prevented fair evaluation (say so separately if so).

Each recommendation needs: what to improve, why it should be fixed first, evidence (cite case IDs and scores), affected tiers/categories, and a one-line plain-English "change" summary precise enough for an engineer to act on without another round of questions.

Finally produce an executive assessment: 2-3 strongest areas, 2-3 areas needing improvement, the single most significant failure pattern, any major risk discovered, and a short plain-English readiness recommendation for broader testing — written for business stakeholders.`;

function truncate(text: string, max = 240): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function caseSummary(c: EvaluatedCase, findings: { explanation: string; missed: string; incorrect: string }) {
  return {
    id: c.id,
    tier: c.tier,
    category: c.category,
    overall: c.overall,
    grade: c.grade,
    status: c.status,
    explanation: truncate(findings.explanation),
    missed: truncate(findings.missed),
    incorrect: truncate(findings.incorrect),
  };
}

function rateBlockSummary(block: RateBlock) {
  return {
    n: block.n,
    avg: block.avg,
    grade: block.grade,
    passPct: block.passPct,
    partialPct: block.partialPct,
    failPct: block.failPct,
  };
}

function formatPayloadAsText(
  overall: ReturnType<typeof rateBlockSummary>,
  tiers: Record<string, ReturnType<typeof rateBlockSummary>>,
  categories: Record<string, ReturnType<typeof rateBlockSummary>>,
  strongestCategory: string | null,
  weakestCategory: string | null,
  uteCount: number,
  cases: ReturnType<typeof caseSummary>[],
): string {
  const lines: string[] = [];

  lines.push('OVERALL METRICS');
  lines.push(`  Grade: ${overall.grade}, Pass: ${overall.passPct}%, Partial: ${overall.partialPct}%, Fail: ${overall.failPct}%`);
  lines.push(`  UTE Count: ${uteCount}`);
  lines.push('');

  lines.push('BY TIER');
  for (const [tier, block] of Object.entries(tiers)) {
    lines.push(`  ${tier}: ${block.grade} (n=${block.n}, avg=${block.avg})`);
  }
  lines.push('');

  lines.push('BY CATEGORY');
  for (const [cat, block] of Object.entries(categories)) {
    lines.push(`  ${cat}: ${block.grade} (n=${block.n}, avg=${block.avg})`);
  }
  lines.push(
    `  Strongest: ${strongestCategory ?? 'unknown'}, Weakest: ${weakestCategory ?? 'unknown'}`,
  );
  lines.push('');

  lines.push('PER-CASE FINDINGS');
  for (const c of cases) {
    lines.push(`Case ${c.id} (Tier: ${c.tier}, Category: ${c.category})`);
    lines.push(`  Grade: ${c.grade} (Overall: ${c.overall}), Status: ${c.status}`);
    lines.push(`  Explanation: ${c.explanation}`);
    lines.push(`  Missed: ${c.missed}`);
    lines.push(`  Incorrect: ${c.incorrect}`);
    lines.push('');
  }

  return lines.join('\n');
}

export async function synthesizeReportFindings(
  metrics: ReportMetrics,
  findingsByCaseId: Map<string, { explanation: string; missed: string; incorrect: string }>,
  modelTag?: string,
): Promise<ReportSynthesis> {
  const client = getOpenAIClient();
  const model = resolveResponsesModel(modelTag ?? 'gpt-4.1');

  const overallSummary = rateBlockSummary(metrics.overall);
  const tiersSummary = Object.fromEntries(metrics.tiers.map(([k, v]) => [k, rateBlockSummary(v)]));
  const categoriesSummary = Object.fromEntries(metrics.categories.map(([k, v]) => [k, rateBlockSummary(v)]));
  const casesSummary = metrics.perCase.map((c) =>
    caseSummary(
      c,
      findingsByCaseId.get(c.id) ?? { explanation: '', missed: '', incorrect: '' },
    ),
  );

  const contentText = formatPayloadAsText(
    overallSummary,
    tiersSummary,
    categoriesSummary,
    metrics.strongestCategory,
    metrics.weakestCategory,
    metrics.uteCount,
    casesSummary,
  );

  try {
    const res = await client.responses.create({
      model,
      instructions: SYNTHESIS_SYSTEM_PROMPT,
      input: [{ role: 'user', content: contentText, type: 'message' }],
      text: {
        format: {
          type: 'json_schema',
          name: 'report_synthesis',
          strict: true,
          schema: SYNTHESIS_JSON_SCHEMA,
        },
      },
      store: false,
      stream: false,
      temperature: 0.2,
    });

    const text = extractAssistantText(res);
    return reportSynthesisSchema.parse(JSON.parse(text));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return {
      failurePatterns: [`Synthesis failed: ${message}`],
      strengths: [],
      weaknesses: [],
      top3: [1, 2, 3].map((priority) => ({
        priority,
        what: 'Synthesis unavailable',
        whyFirst: `The recommendation synthesis call failed (${message}); see per-case detail below.`,
        evidence: '',
        affected: '',
        change: '',
        impact: '',
      })),
      exec: {
        strongestAreas: [],
        improvementAreas: [],
        mostSignificantFailure: `Synthesis unavailable: ${message}`,
        majorRisk: '',
        readiness: '',
      },
    };
  }
}
