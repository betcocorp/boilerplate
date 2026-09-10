import { describe, expect, it } from 'vitest';

import { parseTestCsvContent, parseMultiTurnJsonCell, parseMultiTurnJsonFromForm } from './csv';
import { parseMultiTurnFromInputPayload } from './multi-turn';
import {
  buildTestItemsFromScenarioSet,
  loadMultiTurnScenarioSetsFromDisk,
  parseMultiTurnScenarioSetJson,
} from './multi-turn-import';

const VALID_SET = JSON.stringify({
  set_id: 'product-multi-turn-v1',
  name: 'Product specialist multi-turn',
  intended_agent: 'product',
  scenarios: [
    {
      version: 1,
      scenario_id: 'carry-1',
      title: 'Follow-up keeps the product',
      turns: [
        { prompt: 'What is pH7Q used for?', expectations: { must_mention: ['pH7Q'] } },
        { prompt: 'Is it safe on sealed concrete?', expectations: { minimum_concepts: ['states whether the surface is covered by the label'] } },
      ],
      assertions: [{ type: 'context_carry', from_turn: 1, turn: 2, anchor: 'pH7Q' }],
    },
    {
      version: 1,
      turns: [{ prompt: 'First' }, { prompt: 'Second' }],
    },
  ],
});

describe('parseMultiTurnScenarioSetJson', () => {
  it('accepts a valid set', () => {
    const parsed = parseMultiTurnScenarioSetJson(VALID_SET);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.set.scenarios).toHaveLength(2);
      expect(parsed.set.intended_agent).toBe('product');
    }
  });

  it('reports invalid JSON without throwing', () => {
    const parsed = parseMultiTurnScenarioSetJson('{ not json');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain('Not valid JSON');
    }
  });

  it('reports a schema violation with a field path', () => {
    const parsed = parseMultiTurnScenarioSetJson(
      JSON.stringify({
        set_id: 'x',
        name: 'x',
        intended_agent: 'product',
        // A scenario needs at least two turns to be a scenario.
        scenarios: [{ version: 1, turns: [{ prompt: 'only one' }] }],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain('scenarios.0.turns');
    }
  });

  it('rejects an out-of-bounds assertion turn reference (the contract superRefine)', () => {
    const parsed = parseMultiTurnScenarioSetJson(
      JSON.stringify({
        set_id: 'x',
        name: 'x',
        intended_agent: 'product',
        scenarios: [
          {
            version: 1,
            turns: [{ prompt: 'a' }, { prompt: 'b' }],
            assertions: [{ type: 'mentions', turn: 7, any_of: ['x'] }],
          },
        ],
      }),
    );
    expect(parsed.ok).toBe(false);
  });
});

describe('buildTestItemsFromScenarioSet', () => {
  it('creates one row per scenario with turn 1 in `prompt` and the scenario in input_payload', () => {
    const parsed = parseMultiTurnScenarioSetJson(VALID_SET);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const items = buildTestItemsFromScenarioSet({
      testId: 'test-1',
      set: parsed.set,
      sourceFileName: 'product.json',
    });

    expect(items).toHaveLength(2);
    expect(items[0].row_index).toBe(1);
    expect(items[1].row_index).toBe(2);
    expect(items[0].prompt).toBe('What is pH7Q used for?');
    // Graded by the multi-turn evaluator against per-turn expectations, not these columns.
    // B0-932 — a multi-turn row carries no item-level concepts; the per-turn expectations grade it.
    expect(items[0].minimum_concepts).toEqual([]);
    expect(items[0].expected_concepts).toEqual([]);
    expect(items[0].expected_criteria).toEqual([]);
    expect(items[0].intended_agent_item).toBe('product');

    const roundTripped = parseMultiTurnFromInputPayload(items[0].input_payload);
    expect(roundTripped.kind).toBe('multi_turn');
    if (roundTripped.kind === 'multi_turn') {
      expect(roundTripped.scenario.turns).toHaveLength(2);
      expect(roundTripped.scenario.assertions?.[0].type).toBe('context_carry');
    }

    expect(items[0].metadata).toMatchObject({
      added_via: 'multi_turn_json_import',
      multi_turn_turn_count: '2',
      multi_turn_set_id: 'product-multi-turn-v1',
      multi_turn_source_file: 'product.json',
    });
  });
});

describe('loadMultiTurnScenarioSetsFromDisk', () => {
  it('returns nothing (not an error) when the fixtures directory does not exist', async () => {
    const loaded = await loadMultiTurnScenarioSetsFromDisk(
      '/tmp/definitely-not-a-real-bex-repo-root',
    );
    expect(loaded.sets).toEqual([]);
    expect(loaded.errors).toEqual([]);
  });

  it('reads whatever the B0-539 fixtures directory currently holds without throwing', async () => {
    const loaded = await loadMultiTurnScenarioSetsFromDisk();
    // The directory is owned by a sibling ticket, so its contents are not asserted — only that
    // every file present is either a valid set or a reported error, never a crash.
    expect(Array.isArray(loaded.sets)).toBe(true);
    expect(Array.isArray(loaded.errors)).toBe(true);
  });
});

describe('CSV escape hatch (multi_turn_json)', () => {
  const scenarioCell = JSON.stringify({
    version: 1,
    turns: [{ prompt: 'Turn one' }, { prompt: 'Turn two' }],
  });

  it('routes a valid cell into input_payload.multi_turn', () => {
    const rows = parseTestCsvContent(
      `question,multi_turn_json\n"Turn one","${scenarioCell.replace(/"/g, '""')}"\n`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].multiTurnScenario?.turns).toHaveLength(2);
    expect(parseMultiTurnFromInputPayload(rows[0].inputPayload).kind).toBe('multi_turn');
    expect(rows[0].metadata.multi_turn_turn_count).toBe('2');
  });

  it('drops a malformed cell instead of failing the whole upload', () => {
    const rows = parseTestCsvContent(
      'question,multi_turn_json\n"Just a prompt","{ broken json"\n',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].multiTurnScenario).toBeNull();
    expect(parseMultiTurnFromInputPayload(rows[0].inputPayload).kind).toBe('single_turn');
  });

  it('drops a schema-invalid cell (one turn is not a scenario)', () => {
    expect(parseMultiTurnJsonCell(JSON.stringify({ version: 1, turns: [{ prompt: 'a' }] }))).toBeNull();
  });

  it('never lets multi_turn_json leak into metadata as a raw blob', () => {
    const rows = parseTestCsvContent(
      `question,multi_turn_json\n"Turn one","${scenarioCell.replace(/"/g, '""')}"\n`,
    );
    expect(rows[0].metadata.multi_turn_json).toBeUndefined();
  });
});

describe('parseMultiTurnJsonFromForm', () => {
  it('treats a blank field as "single-turn row"', () => {
    const parsed = parseMultiTurnJsonFromForm('   ');
    expect(parsed).toEqual({ ok: true, scenario: null });
  });

  it('REPORTS a malformed scenario rather than dropping it (unlike the CSV cell)', () => {
    const parsed = parseMultiTurnJsonFromForm('{ broken');
    expect(parsed.ok).toBe(false);
  });

  it('reports a schema violation with a field path', () => {
    const parsed = parseMultiTurnJsonFromForm(
      JSON.stringify({ version: 1, turns: [{ prompt: 'only one' }] }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain('turns');
    }
  });
});
