import { describe, expect, it } from 'vitest';

import type { RunScanRow, StepScanRow } from '~/lib/observability/aggregates';
import {
  buildPipelineStageStripData,
  PIPELINE_STAGES,
  type ToolEventScanRow,
  type ValidatorIssueScanRow,
} from '~/lib/observability/pipeline-stages';

const WINDOW = { from: '2026-08-14T00:00:00.000Z', to: '2026-08-21T00:00:00.000Z' };

function run(overrides: Partial<RunScanRow>): RunScanRow {
  return {
    id: 'run-1',
    status: 'completed',
    confidence: null,
    created_at: '2026-08-20T12:00:00.000Z',
    updated_at: '2026-08-20T12:00:10.000Z',
    routing_decision: 'product',
    ttft_ms: null,
    total_tokens: null,
    prompt_tokens: null,
    cached_prompt_tokens: null,
    ...overrides,
  };
}

function step(overrides: Partial<StepScanRow>): StepScanRow {
  return {
    workflow_run_id: 'run-1',
    step_name: 'orchestration_planner',
    started_at: '2026-08-20T12:00:00.000Z',
    completed_at: '2026-08-20T12:00:01.000Z',
    ...overrides,
  };
}

function toolEvent(overrides: Partial<ToolEventScanRow>): ToolEventScanRow {
  return {
    workflow_run_id: 'run-1',
    event_type: 'tool_called',
    created_at: '2026-08-20T12:00:02.000Z',
    call_id: 'call-1',
    ...overrides,
  };
}

function build(input?: {
  runs?: RunScanRow[];
  steps?: StepScanRow[];
  toolEvents?: ToolEventScanRow[];
  validatorIssueRows?: ValidatorIssueScanRow[];
  forcedToReviewCount?: number;
}) {
  return buildPipelineStageStripData({
    window: WINDOW,
    runs: input?.runs ?? [],
    steps: input?.steps ?? [],
    toolEvents: input?.toolEvents ?? [],
    validatorIssueRows: input?.validatorIssueRows ?? [],
    forcedToReviewCount: input?.forcedToReviewCount ?? 0,
  });
}

describe('PIPELINE_STAGES mapping', () => {
  it('maps the five stages, in pipeline order, onto the step names that actually occur', () => {
    expect(PIPELINE_STAGES.map((stage) => [stage.id, stage.stepName])).toEqual([
      ['route', 'orchestration_planner'],
      ['retrieve', null], // audit-derived: no workflow_steps row exists for retrieval
      ['generate', 'openai_responses_agent'],
      ['validate', 'validator'],
      ['gate', 'early_decline_gate'],
    ]);
  });
});

describe('buildPipelineStageStripData', () => {
  it('clamps a clock-skewed negative step duration at 0 instead of dropping the row', () => {
    const data = build({
      runs: [run({})],
      steps: [
        // Postgres-stamped started_at AFTER the Node-stamped completed_at (clock skew).
        step({
          started_at: '2026-08-20T12:00:00.500Z',
          completed_at: '2026-08-20T12:00:00.400Z',
        }),
      ],
    });

    // The fast step still shows up: n=1 with a 0ms average — never a vanished sample.
    expect(data.route.latency).toEqual({
      avgDurationMs: 0,
      p50DurationMs: 0,
      p95DurationMs: 0,
      sampleSize: 1,
    });
  });

  it('degrades a step name absent from the window to null latency, not a zero average', () => {
    const data = build({
      runs: [run({})],
      steps: [step({})], // only the planner ran
    });

    expect(data.route.latency).not.toBeNull();
    expect(data.generate.latency).toBeNull();
    expect(data.validate.latency).toBeNull();
    expect(data.gate.latency).toBeNull();
    expect(data.retrieve.latency).toBeNull();
  });

  it('reconciles stage latency with the latency-by-step math (avg, nearest-rank p95, n)', () => {
    const data = build({
      runs: [run({ id: 'run-1' }), run({ id: 'run-2' })],
      steps: [
        step({ step_name: 'validator', started_at: '2026-08-20T12:00:00.000Z', completed_at: '2026-08-20T12:00:01.000Z' }),
        step({
          workflow_run_id: 'run-2',
          step_name: 'validator',
          started_at: '2026-08-20T12:00:00.000Z',
          completed_at: '2026-08-20T12:00:03.000Z',
        }),
      ],
    });

    expect(data.validate.latency).toEqual({
      avgDurationMs: 2000,
      p50DurationMs: 1000, // nearest rank over [1000, 3000] — the lower middle value
      p95DurationMs: 3000,
      sampleSize: 2,
    });
  });

  it('derives retrieve latency from paired tool audit rows and counts failed calls', () => {
    const data = build({
      runs: [run({})],
      toolEvents: [
        toolEvent({ call_id: 'call-1', event_type: 'tool_called', created_at: '2026-08-20T12:00:02.000Z' }),
        toolEvent({ call_id: 'call-1', event_type: 'tool_succeeded', created_at: '2026-08-20T12:00:02.400Z' }),
        toolEvent({ call_id: 'call-2', event_type: 'tool_called', created_at: '2026-08-20T12:00:03.000Z' }),
        toolEvent({ call_id: 'call-2', event_type: 'tool_failed', created_at: '2026-08-20T12:00:03.200Z' }),
        // Unsettled call: excluded from timing (no end), but never counted as failed.
        toolEvent({ call_id: 'call-3', event_type: 'tool_called', created_at: '2026-08-20T12:00:04.000Z' }),
      ],
    });

    expect(data.retrieve.latency).toEqual({
      avgDurationMs: 300, // (400 + 200) / 2
      p50DurationMs: 200, // nearest rank over [200, 400]
      p95DurationMs: 400,
      sampleSize: 2,
    });
    expect(data.retrieve.failedToolCallCount).toBe(1);
  });

  it('counts ambiguous routes via the same routing distribution as the aggregate dashboard', () => {
    const data = build({
      runs: [
        run({ id: 'run-1', routing_decision: 'ambiguous' }),
        run({ id: 'run-2', routing_decision: 'ambiguous' }),
        run({ id: 'run-3', routing_decision: 'product' }),
        run({ id: 'run-4', routing_decision: null }), // unrouted ≠ ambiguous
      ],
    });

    expect(data.route.ambiguousRouteCount).toBe(2);
  });

  it('counts skipped/bypassed validators from step output issues, once per run', () => {
    const data = build({
      runs: [run({ id: 'run-1' }), run({ id: 'run-2' }), run({ id: 'run-3' })],
      validatorIssueRows: [
        { workflow_run_id: 'run-1', issues: ['validator_bypassed_for_testing'] },
        // Second row for the same run must not double-count it.
        { workflow_run_id: 'run-1', issues: ['validator_bypassed_for_testing'] },
        {
          workflow_run_id: 'run-2',
          issues: ['validator_skipped_high_similarity_non_safety_route'],
        },
        { workflow_run_id: 'run-3', issues: ['insufficient_safety_evidence'] }, // ran for real
        { workflow_run_id: 'run-3', issues: null }, // malformed/absent issues tolerated
      ],
    });

    expect(data.validate.skippedOrBypassedCount).toBe(2);
  });

  it('reports gate figures: mean final confidence (dashboard rounding) and forced-to-review count', () => {
    const data = build({
      runs: [
        run({ id: 'run-1', confidence: 0.9 }),
        run({ id: 'run-2', confidence: 0.4321 }),
        run({ id: 'run-3', confidence: null }), // no confidence — out of the mean
      ],
      forcedToReviewCount: 5,
    });

    expect(data.gate.meanFinalConfidence).toBe(0.6661); // roundTo((0.9 + 0.4321) / 2, 4)
    expect(data.gate.confidenceSampleSize).toBe(2);
    expect(data.gate.forcedToReviewCount).toBe(5);
  });

  it('surfaces tokens-per-run on the generate stage with its sample size', () => {
    const data = build({
      runs: [
        run({ id: 'run-1', total_tokens: '1200', prompt_tokens: '1000', cached_prompt_tokens: '500' }),
        run({ id: 'run-2' }), // no usage — out of the sample, not a zero
      ],
    });

    expect(data.generate.avgTotalTokens).toBe(1200);
    expect(data.generate.tokenSampleSize).toBe(1);
  });

  it('carries the window and total run count for the strip header', () => {
    const data = build({ runs: [run({ id: 'run-1' }), run({ id: 'run-2' })] });

    expect(data.windowFrom).toBe(WINDOW.from);
    expect(data.windowTo).toBe(WINDOW.to);
    expect(data.totalRuns).toBe(2);
  });
});
