import { parseMultiTurnFromInputPayload, type MultiTurnScenario } from './multi-turn';

/**
 * B0-537 — client-safe presentation helpers for multi-turn items. Deliberately dependency-light
 * (zod + the scenario contract only) so `'use client'` components can import them without pulling
 * in `csv-parse`, `node:fs`, or the OpenAI client.
 */

export type MultiTurnItemView =
  | { kind: 'single_turn' }
  | { kind: 'multi_turn'; scenario: MultiTurnScenario; turnCount: number }
  /** Stored but unparseable — surfaced in the UI rather than hidden, since the runner will fail it. */
  | { kind: 'invalid'; message: string };

/** Reads `test_items.input_payload` into something renderable. Never throws. */
export function readMultiTurnItemView(inputPayload: unknown): MultiTurnItemView {
  const parsed = parseMultiTurnFromInputPayload(inputPayload);
  if (parsed.kind === 'multi_turn') {
    return {
      kind: 'multi_turn',
      scenario: parsed.scenario,
      turnCount: parsed.scenario.turns.length,
    };
  }
  return parsed;
}

/** Short badge label, e.g. "Multi-turn · 4 turns". */
export function formatMultiTurnBadgeLabel(turnCount: number): string {
  return `Multi-turn · ${turnCount} turn${turnCount === 1 ? '' : 's'}`;
}

/**
 * Pretty-printed scenario for the edit dialog's textarea. Returns '' for a single-turn row; for a
 * stored-but-invalid scenario returns the raw stored value so an author can actually fix it rather
 * than being handed an empty box that would silently delete their work on save.
 */
export function formatMultiTurnScenarioForEditing(inputPayload: unknown): string {
  const view = readMultiTurnItemView(inputPayload);
  if (view.kind === 'multi_turn') {
    return JSON.stringify(view.scenario, null, 2);
  }
  if (view.kind === 'invalid' && inputPayload && typeof inputPayload === 'object') {
    const raw = (inputPayload as Record<string, unknown>).multi_turn;
    return raw === undefined ? '' : JSON.stringify(raw, null, 2);
  }
  return '';
}

/** One-line summary of a scenario's turns for a `title` tooltip. */
export function formatMultiTurnTurnsTooltip(scenario: MultiTurnScenario): string {
  return scenario.turns
    .map((turn, index) => `${index + 1}. ${turn.prompt}`)
    .join('\n');
}
