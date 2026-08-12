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
          changePseudocode: { type: 'array', items: { type: 'string' } },
          impact: { type: 'string' },
        },
        required: [
          'priority',
          'what',
          'whyFirst',
          'evidence',
          'affected',
          'change',
          'changePseudocode',
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

Each recommendation needs: what to improve, why it should be fixed first, evidence (cite case IDs and scores), affected tiers/categories, a one-line plain-English "change" summary, and "changePseudocode" — an array of lines (IF/THEN, FOR EACH, function-like) precise enough for an engineer to implement without another round of questions: state the trigger/condition, the action, guard clauses for edge cases (especially safety/scope boundaries), any thresholds/parameters named explicitly, and a fallback that flags rather than guesses when required information is absent. Keep it general enough to hold for future questions of the same type, not overfit to the exact cases given.

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

export async function synthesizeReportFindings(
  metrics: ReportMetrics,
  findingsByCaseId: Map<string, { explanation: string; missed: string; incorrect: string }>,
  modelTag?: string,
): Promise<ReportSynthesis> {
  const client = getOpenAIClient();
  const model = resolveResponsesModel(modelTag ?? 'gpt-4.1');

  const payload = {
    overall: rateBlockSummary(metrics.overall),
    tiers: Object.fromEntries(metrics.tiers.map(([k, v]) => [k, rateBlockSummary(v)])),
    categories: Object.fromEntries(metrics.categories.map(([k, v]) => [k, rateBlockSummary(v)])),
    strongestCategory: metrics.strongestCategory,
    weakestCategory: metrics.weakestCategory,
    uteCount: metrics.uteCount,
    cases: metrics.perCase.map((c) =>
      caseSummary(
        c,
        findingsByCaseId.get(c.id) ?? { explanation: '', missed: '', incorrect: '' },
      ),
    ),
  };

  try {
    const res = await client.responses.create({
      model,
      instructions: SYNTHESIS_SYSTEM_PROMPT,
      input: [{ role: 'user', content: JSON.stringify(payload), type: 'message' }],
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
        changePseudocode: ['# synthesis unavailable'],
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
