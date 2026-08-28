import type { Response } from 'openai/resources/responses/responses';
import { z } from 'zod';

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

/**
 * B0-735 — this batch is a SLICE of a larger run; the digest is an intermediate summary that will
 * be merged with digests from other batches, never the final report. The numeric cap (not just
 * "keep it concise") is deliberate: strict json_schema mode has no `maxItems`, so without an
 * explicit number the model tends to write one bullet per case, which is exactly the unbounded
 * growth this digest step exists to avoid.
 */
const DIGEST_SYSTEM_PROMPT = `You are summarizing ONE BATCH of cases from a larger agent-evaluation run, following Betco's internal agent-evaluation methodology. This batch is a slice of a bigger run — your output will be merged with digests from other batches into a final report.

From only the cases in this batch, list AT MOST 5 of the clearest failure patterns (cite case IDs), AT MOST 5 of the clearest strengths (cite case IDs), and AT MOST 5 of the clearest recurring weaknesses (cite case IDs). Do not write one bullet per case — merge similar cases into a single bullet citing all their IDs.`;

const DIGEST_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    failurePatterns: { type: 'array', items: { type: 'string' } },
    strengths: { type: 'array', items: { type: 'string' } },
    weaknesses: { type: 'array', items: { type: 'string' } },
  },
  required: ['failurePatterns', 'strengths', 'weaknesses'],
} as const;

const batchDigestSchema = z.object({
  failurePatterns: z.array(z.string()),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
});

type BatchDigest = z.infer<typeof batchDigestSchema>;

/**
 * B0-735 — above this many cases, the synthesis call switches from raw per-case text to the
 * chunked digest-then-merge path. Kept small so even a model that ignores the "at most 5 bullets"
 * instruction and writes one bullet per case per list (worst case ~3 * CHUNK_SIZE short bullets)
 * still fits comfortably under `DIGEST_MAX_OUTPUT_TOKENS`.
 */
const CHUNK_SIZE = 25;
/** Concurrent digest calls in flight, mirroring the grading batch size in `orchestrator.ts`. */
const DIGEST_CONCURRENCY = 4;
/**
 * Generous headroom for the largest legitimate output (a full Top-3 + exec write-up). Structured
 * outputs (`strict: true`) guarantee syntactically valid JSON as long as generation isn't cut off
 * by this cap — truncation is the only way this call produces invalid JSON — so the cap only needs
 * to be big enough that the model never legitimately needs more, not tight.
 */
const SYNTHESIS_MAX_OUTPUT_TOKENS = 8000;
/** Sized for the worst case above (~3 * CHUNK_SIZE short bullets), not just the instructed one. */
const DIGEST_MAX_OUTPUT_TOKENS = 4000;

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

type CaseSummary = ReturnType<typeof caseSummary>;

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

/** Splits `cases` into `<= CHUNK_SIZE`-sized groups, preserving order. */
export function chunkCases(cases: CaseSummary[], chunkSize = CHUNK_SIZE): CaseSummary[][] {
  const chunks: CaseSummary[][] = [];
  for (let i = 0; i < cases.length; i += chunkSize) {
    chunks.push(cases.slice(i, i + chunkSize));
  }
  return chunks;
}

function formatCasesAsText(cases: CaseSummary[]): string {
  const lines: string[] = [];
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

/**
 * Merges per-batch digests into one bounded text section. Bounded by chunk COUNT, not case count
 * — the input this feeds into the final synthesis call stays roughly constant-sized as a run grows
 * from, say, 200 to 1000 cases (more, smaller bullet lists rather than a longer one).
 */
export function formatDigestsAsText(digests: BatchDigest[]): string {
  const lines: string[] = [];
  lines.push(`CROSS-BATCH DIGEST (aggregated from ${digests.length} batches covering all cases)`);
  lines.push('');

  lines.push('FAILURE PATTERNS BY BATCH');
  digests.forEach((d, i) => d.failurePatterns.forEach((line) => lines.push(`  [Batch ${i + 1}] ${line}`)));
  lines.push('');

  lines.push('STRENGTHS BY BATCH');
  digests.forEach((d, i) => d.strengths.forEach((line) => lines.push(`  [Batch ${i + 1}] ${line}`)));
  lines.push('');

  lines.push('WEAKNESSES BY BATCH');
  digests.forEach((d, i) => d.weaknesses.forEach((line) => lines.push(`  [Batch ${i + 1}] ${line}`)));
  lines.push('');

  return lines.join('\n');
}

function formatMetricsHeaderAsText(
  overall: ReturnType<typeof rateBlockSummary>,
  tiers: Record<string, ReturnType<typeof rateBlockSummary>>,
  categories: Record<string, ReturnType<typeof rateBlockSummary>>,
  strongestCategory: string | null,
  weakestCategory: string | null,
  uteCount: number,
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

  return lines.join('\n');
}

/**
 * Structured outputs (`strict: true`) only ever produce invalid JSON when generation is cut off
 * mid-string by `max_output_tokens` — so checking `incomplete_details` first turns that failure
 * mode into a clear "raise the cap" error instead of a `JSON.parse` message that doesn't say why.
 * Labeled per call site so a future failure names which call (and which chunk) broke.
 */
function parseStructuredResponse<T>(res: Response, schema: z.ZodType<T>, label: string): T {
  if (res.incomplete_details?.reason === 'max_output_tokens') {
    throw new Error(`${label}: output truncated at max_output_tokens; raise the cap or shrink the input.`);
  }
  try {
    return schema.parse(JSON.parse(extractAssistantText(res)));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`${label}: ${message}`);
  }
}

async function digestChunk(
  client: ReturnType<typeof getOpenAIClient>,
  model: string,
  chunk: CaseSummary[],
  label: string,
): Promise<BatchDigest> {
  const res = await client.responses.create({
    model,
    instructions: DIGEST_SYSTEM_PROMPT,
    input: [{ role: 'user', content: formatCasesAsText(chunk), type: 'message' }],
    text: {
      format: {
        type: 'json_schema',
        name: 'batch_digest',
        strict: true,
        schema: DIGEST_JSON_SCHEMA,
      },
    },
    store: false,
    stream: false,
    temperature: 0.2,
    max_output_tokens: DIGEST_MAX_OUTPUT_TOKENS,
  });

  return parseStructuredResponse(res, batchDigestSchema, label);
}

/** Runs `digestChunk` over every chunk in bounded concurrency, mirroring `scoreRemainingCases`. */
async function digestAllChunks(
  client: ReturnType<typeof getOpenAIClient>,
  model: string,
  chunks: CaseSummary[][],
): Promise<BatchDigest[]> {
  const digests: BatchDigest[] = new Array(chunks.length);
  for (let i = 0; i < chunks.length; i += DIGEST_CONCURRENCY) {
    const batch = chunks.slice(i, i + DIGEST_CONCURRENCY);
    const results = await Promise.all(
      batch.map((chunk, j) =>
        digestChunk(client, model, chunk, `Batch digest ${i + j + 1}/${chunks.length}`),
      ),
    );
    results.forEach((result, j) => {
      digests[i + j] = result;
    });
  }
  return digests;
}

/**
 * Generates the Top-3 recommendation synthesis for a completed report (B0-453).
 *
 * B0-735 — the input this feeds the model used to scale linearly with case count (the full
 * per-case findings text for every case), with no `max_output_tokens` set. At 150+ cases the
 * model's required output — which cites case IDs across every field — got truncated mid-JSON, the
 * parse threw, and that failure used to be swallowed here into a fake-success placeholder instead
 * of propagating. Above `CHUNK_SIZE` cases this now runs a bounded map-reduce: each chunk gets its
 * own small "batch digest" call, and the final Top-3/exec call reads the merged digests instead of
 * raw per-case text — so the final call's input (and required output) stays roughly constant-sized
 * as the run grows, rather than scaling with it. A genuine failure now throws, and the caller
 * (`generateReport` in `orchestrator.ts`) already has a `status: 'failed'` / `state.error` path for
 * exactly that — this no longer bypasses it.
 */
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

  const metricsHeaderText = formatMetricsHeaderAsText(
    overallSummary,
    tiersSummary,
    categoriesSummary,
    metrics.strongestCategory,
    metrics.weakestCategory,
    metrics.uteCount,
  );

  const chunks = chunkCases(casesSummary);
  const contentText =
    chunks.length > 1
      ? `${metricsHeaderText}${formatDigestsAsText(await digestAllChunks(client, model, chunks))}`
      : `${metricsHeaderText}PER-CASE FINDINGS\n${formatCasesAsText(casesSummary)}`;

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
    max_output_tokens: SYNTHESIS_MAX_OUTPUT_TOKENS,
  });

  return parseStructuredResponse(res, reportSynthesisSchema, 'Final synthesis call');
}
