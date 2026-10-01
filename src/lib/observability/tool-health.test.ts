import { describe, expect, it } from 'vitest';

import type { ToolTraceEntry } from '~/lib/audit/trace';
import type { AggregateWindow } from '~/lib/observability/aggregates';
import {
  buildToolHealthData,
  type AgentStepToolTraceRow,
} from '~/lib/observability/tool-health';
import { PRODUCT_TOOL_NAMES } from '~/lib/tools/tool-schemas';

const WINDOW: AggregateWindow = {
  from: '2026-08-15T00:00:00.000Z',
  to: '2026-08-22T00:00:00.000Z',
};

let callIdSeq = 0;

/** A minimally-valid `toolTraceEntrySchema` element; every required field is present. */
function entry(overrides: Partial<ToolTraceEntry> = {}): ToolTraceEntry {
  callIdSeq += 1;
  return {
    toolName: 'search_product_docs',
    callId: `call-${callIdSeq}`,
    argumentsPreview: '{}',
    outputPreview: '{}',
    ok: true,
    durationMs: 100,
    ...overrides,
  };
}

function step(entries: ToolTraceEntry[], runId = 'run-1'): AgentStepToolTraceRow {
  return { workflow_run_id: runId, output: { toolTrace: entries } };
}

function build(agentSteps: AgentStepToolTraceRow[]) {
  return buildToolHealthData({ window: WINDOW, agentSteps });
}

function rowFor(agentSteps: AgentStepToolTraceRow[], toolName: string) {
  const row = build(agentSteps).rows.find((candidate) => candidate.toolName === toolName);
  if (!row) {
    throw new Error(`expected a row for ${toolName}`);
  }
  return row;
}

describe('buildToolHealthData — speculative exclusion (B0-436)', () => {
  it('excludes speculative and reused-speculative entries from calls, failures and latency', () => {
    const steps = [
      step([
        entry({ durationMs: 100 }),
        // Ran before the model asked — not an ordinary call.
        entry({ speculative: true, durationMs: 9_000 }),
        // Same work counted twice; its durationMs is the speculative call's.
        entry({ reusedSpeculativeResult: true, durationMs: 9_000, ok: false }),
      ]),
    ];

    const data = build(steps);

    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({
      toolName: 'search_product_docs',
      callCount: 1,
      failureCount: 0, // the failing entry was the reused-speculative one
      p50DurationMs: 100, // 9,000ms speculative duration never enters the sample
      p95DurationMs: 100,
      durationSampleSize: 1,
    });
    expect(data.speculativeExcludedCount).toBe(2);
  });

  it('drops a tool entirely — and out of toolsWithTraffic — when all its entries are speculative', () => {
    const data = build([
      step([
        entry({ toolName: 'get_product_spec' }),
        entry({ toolName: 'search_product_docs', speculative: true }),
        entry({ toolName: 'search_product_docs', speculative: true }),
      ]),
    ]);

    expect(data.rows.map((row) => row.toolName)).toEqual(['get_product_spec']);
    expect(data.toolsWithTraffic).toBe(1);
    expect(data.speculativeExcludedCount).toBe(2);
  });

  it('treats an explicit `speculative: false` as an ordinary call', () => {
    const data = build([
      step([entry({ speculative: false, reusedSpeculativeResult: false })]),
    ]);

    expect(data.rows[0]?.callCount).toBe(1);
    expect(data.speculativeExcludedCount).toBe(0);
  });
});

describe('buildToolHealthData — optional durationMs', () => {
  it('counts a missing duration as unknown rather than 0ms', () => {
    // A 0ms default would halve the p50 here; the honest answer is a 1-sample percentile.
    const data = build([step([entry({ durationMs: undefined }), entry({ durationMs: 400 })])]);

    expect(data.rows[0]).toMatchObject({
      callCount: 2, // the undated call is still a call
      durationSampleSize: 1,
      p50DurationMs: 400,
      p95DurationMs: 400,
    });
    expect(data.entriesMissingDuration).toBe(1);
  });

  it('renders null percentiles, never 0, when no retained entry carries a duration', () => {
    const data = build([
      step([entry({ durationMs: undefined }), entry({ durationMs: undefined, ok: false })]),
    ]);

    expect(data.rows[0]).toMatchObject({
      callCount: 2,
      failureCount: 1,
      durationSampleSize: 0,
      p50DurationMs: null,
      p95DurationMs: null,
    });
    expect(data.rows[0]?.p50DurationMs).not.toBe(0);
    expect(data.entriesMissingDuration).toBe(2);
  });

  it('keeps the audit invariant sum(callCount) === sum(durationSampleSize) + entriesMissingDuration', () => {
    const data = build([
      step([
        entry({ durationMs: 10 }),
        entry({ durationMs: undefined }),
        entry({ toolName: 'get_efficacy_data', durationMs: undefined }),
        entry({ toolName: 'get_efficacy_data', durationMs: 20 }),
        entry({ speculative: true, durationMs: 999 }),
      ]),
    ]);

    const calls = data.rows.reduce((sum, row) => sum + row.callCount, 0);
    const samples = data.rows.reduce((sum, row) => sum + row.durationSampleSize, 0);

    expect(calls).toBe(4);
    expect(samples + data.entriesMissingDuration).toBe(calls);
  });

  it('computes percentiles by nearest rank over the dated entries only', () => {
    const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const row = rowFor(
      [step(durations.map((durationMs) => entry({ durationMs })))],
      'search_product_docs',
    );

    // Nearest rank, no interpolation: p50 of an even sample is the lower middle value.
    expect(row.p50DurationMs).toBe(50);
    expect(row.p95DurationMs).toBe(100);
    expect(row.durationSampleSize).toBe(10);
  });
});

describe('buildToolHealthData — failure rate', () => {
  it('derives failureRate from ok === false', () => {
    const row = rowFor(
      [step([entry({ ok: false }), entry({ ok: false }), entry({ ok: true }), entry({ ok: true })])],
      'search_product_docs',
    );

    expect(row).toMatchObject({ callCount: 4, failureCount: 2, failureRate: 0.5 });
  });

  it('reports a real 0 failureRate for a healthy tool', () => {
    expect(rowFor([step([entry(), entry()])], 'search_product_docs').failureRate).toBe(0);
  });

  it('rounds a repeating failureRate to 4dp instead of leaking float noise', () => {
    const row = rowFor(
      [step([entry({ ok: false }), entry(), entry()])],
      'search_product_docs',
    );

    expect(row.failureRate).toBe(0.3333);
  });
});

describe('buildToolHealthData — unknown tool names', () => {
  it('retains an unrecognised tool with known: false and counts it in unknownToolCount', () => {
    const data = build([
      step([
        entry({ toolName: 'search_product_docs' }),
        entry({ toolName: 'get_dilution_ratio_renamed' }),
        entry({ toolName: 'get_dilution_ratio_renamed', ok: false }),
        entry({ toolName: 'another_rogue_tool' }),
      ]),
    ]);

    const rogue = data.rows.find((row) => row.toolName === 'get_dilution_ratio_renamed');
    expect(rogue).toMatchObject({ known: false, callCount: 2, failureCount: 1, failureRate: 0.5 });
    expect(data.unknownToolCount).toBe(2);
    // Unknown names must never inflate the "N of the registered tools" numerator.
    expect(data.toolsWithTraffic).toBe(1);
    expect(data.totalRegisteredTools).toBe(PRODUCT_TOOL_NAMES.length);
  });
});

describe('buildToolHealthData — traffic coverage', () => {
  it('counts distinct known tools with traffic, not total calls', () => {
    const data = build([
      step([
        entry({ toolName: 'search_product_docs' }),
        entry({ toolName: 'search_product_docs' }),
        entry({ toolName: 'search_product_docs' }),
        entry({ toolName: 'lookup_cross_reference' }),
      ]),
      step([entry({ toolName: 'lookup_cross_reference' })], 'run-2'),
    ]);

    expect(data.toolsWithTraffic).toBe(2);
    expect(data.totalRegisteredTools).toBe(PRODUCT_TOOL_NAMES.length);
    expect(data.totalRegisteredTools).toBeGreaterThan(data.toolsWithTraffic);
  });

  it('aggregates one tool across multiple runs', () => {
    const row = rowFor(
      [
        step([entry({ durationMs: 100 }), entry({ durationMs: 200 })], 'run-1'),
        step([entry({ durationMs: 300, ok: false })], 'run-2'),
      ],
      'search_product_docs',
    );

    expect(row).toMatchObject({
      callCount: 3,
      failureCount: 1,
      durationSampleSize: 3,
      p50DurationMs: 200,
      p95DurationMs: 300,
    });
  });
});

describe('buildToolHealthData — ordering', () => {
  it('sorts rows descending by callCount, breaking ties by tool name', () => {
    const data = build([
      step([
        entry({ toolName: 'get_safety_constraints' }),
        entry({ toolName: 'search_product_docs' }),
        entry({ toolName: 'search_product_docs' }),
        entry({ toolName: 'search_product_docs' }),
        entry({ toolName: 'lookup_cross_reference' }),
        entry({ toolName: 'lookup_cross_reference' }),
        entry({ toolName: 'get_efficacy_data' }),
      ]),
    ]);

    expect(data.rows.map((row) => row.toolName)).toEqual([
      'search_product_docs', // 3
      'lookup_cross_reference', // 2
      'get_efficacy_data', // 1, alphabetically before get_safety_constraints
      'get_safety_constraints', // 1
    ]);
  });
});

describe('buildToolHealthData — defensive parsing', () => {
  it('skips malformed rows without throwing and keeps the well-formed ones', () => {
    const malformed: AgentStepToolTraceRow[] = [
      { workflow_run_id: 'run-a', output: null },
      { workflow_run_id: 'run-b', output: undefined },
      { workflow_run_id: 'run-c', output: 'not an object' },
      { workflow_run_id: 'run-d', output: [] }, // array, not the step blob
      { workflow_run_id: 'run-e', output: {} }, // step predating toolTrace capture
      { workflow_run_id: 'run-f', output: { toolTrace: null } },
      { workflow_run_id: 'run-g', output: { toolTrace: 'nope' } },
      { workflow_run_id: 'run-h', output: { toolTrace: [{ toolName: 'search_product_docs' }] } },
      { workflow_run_id: 'run-i', output: { toolTrace: [] } },
    ];

    const data = build([...malformed, step([entry({ durationMs: 42 })], 'run-j')]);

    expect(data.rows).toEqual([
      {
        toolName: 'search_product_docs',
        known: true,
        callCount: 1,
        failureCount: 0,
        failureRate: 0,
        p50DurationMs: 42,
        p95DurationMs: 42,
        durationSampleSize: 1,
      },
    ]);
    expect(data.speculativeExcludedCount).toBe(0);
    expect(data.entriesMissingDuration).toBe(0);
  });

  it('returns an empty, non-null-percentile-free shape for no input', () => {
    const data = build([]);

    expect(data).toEqual({
      windowFrom: WINDOW.from,
      windowTo: WINDOW.to,
      rows: [],
      toolsWithTraffic: 0,
      totalRegisteredTools: PRODUCT_TOOL_NAMES.length,
      unknownToolCount: 0,
      speculativeExcludedCount: 0,
      entriesMissingDuration: 0,
    });
  });

  it('echoes the window bounds it was given', () => {
    const data = build([step([entry()])]);

    expect(data.windowFrom).toBe(WINDOW.from);
    expect(data.windowTo).toBe(WINDOW.to);
  });
});
