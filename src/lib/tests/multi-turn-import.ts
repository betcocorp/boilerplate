import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  MULTI_TURN_PAYLOAD_KEY,
  multiTurnScenarioSetSchema,
  type MultiTurnScenario,
  type MultiTurnScenarioSet,
} from './multi-turn';
import type { NewTestItemRecord } from './types';

/**
 * B0-537 — the authoring path for multi-turn scenarios.
 *
 * Scenarios do not flatten into a CSV cell (ordered turns, per-turn expectations, and a
 * discriminated union of cross-turn assertions), so the primary path is **JSON**: a
 * `multiTurnScenarioSetSchema` file per SME agent, and one `test_items` row per scenario. The
 * scenario JSON files themselves live in `src/lib/tests/fixtures/multi-turn/` (owned by B0-539);
 * this module only reads that directory, so the two tickets never touch the same files.
 *
 * A CSV escape hatch also exists for one-off rows — see `parseMultiTurnJsonCell` in `./csv.ts`.
 */

/** Repo-relative home of the B0-539 scenario-set JSON files. Read-only from here. */
export const MULTI_TURN_FIXTURES_DIR = path.join(
  'src',
  'lib',
  'tests',
  'fixtures',
  'multi-turn',
);

export type ScenarioSetParseResult =
  | { ok: true; set: MultiTurnScenarioSet }
  | { ok: false; message: string };

/**
 * Validates one scenario-set JSON document. Returns a structured failure rather than throwing so a
 * bulk import can report every bad file at once, the same tolerance principle the CSV importer uses.
 */
export function parseMultiTurnScenarioSetJson(content: string): ScenarioSetParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    return {
      ok: false,
      message: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const parsed = multiTurnScenarioSetSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, message: `Not a valid multi-turn scenario set — ${issues}` };
  }

  return { ok: true, set: parsed.data };
}

export type LoadedScenarioSets = {
  sets: Array<{ fileName: string; set: MultiTurnScenarioSet }>;
  /** One entry per unreadable/invalid file — never thrown, so one bad file can't block the rest. */
  errors: Array<{ fileName: string; message: string }>;
};

/**
 * Reads every `*.json` scenario set out of {@link MULTI_TURN_FIXTURES_DIR}. A missing directory is
 * NOT an error — B0-539 may not have landed its files yet — it simply yields no sets.
 */
export async function loadMultiTurnScenarioSetsFromDisk(
  baseDir: string = process.cwd(),
): Promise<LoadedScenarioSets> {
  const directory = path.join(baseDir, MULTI_TURN_FIXTURES_DIR);

  let fileNames: string[];
  try {
    fileNames = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return { sets: [], errors: [] };
  }

  const sets: LoadedScenarioSets['sets'] = [];
  const errors: LoadedScenarioSets['errors'] = [];

  for (const fileName of fileNames) {
    try {
      const content = await readFile(path.join(directory, fileName), 'utf8');
      const parsed = parseMultiTurnScenarioSetJson(content);
      if (parsed.ok) {
        sets.push({ fileName, set: parsed.set });
      } else {
        errors.push({ fileName, message: parsed.message });
      }
    } catch (error) {
      errors.push({
        fileName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { sets, errors };
}

/**
 * Builds the `test_items` insert for one scenario. Storage per the B0-537 contract: `prompt` holds
 * TURN 1 (so every existing list/search/routing surface keeps working), and the whole scenario goes
 * under `input_payload.multi_turn`.
 *
 * `expected_should_answer` / `expected_result_type` are deliberately left NULL: a multi-turn row is
 * graded by `multi-turn-evaluator.ts` against its PER-TURN expectations, and copying the final
 * turn's expectation into the row's own columns would imply the single-turn grader ran.
 */
export function buildTestItemFromScenario(params: {
  testId: string;
  rowIndex: number;
  scenario: MultiTurnScenario;
  setId?: string;
  intendedAgent?: string;
  sourceFileName?: string;
}): NewTestItemRecord {
  const { scenario } = params;

  return {
    test_id: params.testId,
    row_index: params.rowIndex,
    prompt: scenario.turns[0].prompt,
    expected_should_answer: null,
    expected_result_type: null,
    intended_agent_item: params.intendedAgent ?? null,
    input_payload: {
      [MULTI_TURN_PAYLOAD_KEY]: JSON.parse(JSON.stringify(scenario)),
    },
    metadata: {
      added_via: 'multi_turn_json_import',
      multi_turn_turn_count: String(scenario.turns.length),
      multi_turn_assertion_count: String(scenario.assertions?.length ?? 0),
      ...(scenario.scenario_id ? { multi_turn_scenario_id: scenario.scenario_id } : {}),
      ...(scenario.title ? { multi_turn_title: scenario.title } : {}),
      ...(params.setId ? { multi_turn_set_id: params.setId } : {}),
      ...(params.sourceFileName ? { multi_turn_source_file: params.sourceFileName } : {}),
    },
  };
}

/** One `test_items` row per scenario in the set, numbered from `startRowIndex` (1-based). */
export function buildTestItemsFromScenarioSet(params: {
  testId: string;
  set: MultiTurnScenarioSet;
  startRowIndex?: number;
  sourceFileName?: string;
}): NewTestItemRecord[] {
  const start = params.startRowIndex ?? 1;
  return params.set.scenarios.map((scenario, index) =>
    buildTestItemFromScenario({
      testId: params.testId,
      rowIndex: start + index,
      scenario,
      setId: params.set.set_id,
      intendedAgent: params.set.intended_agent,
      sourceFileName: params.sourceFileName,
    }),
  );
}
