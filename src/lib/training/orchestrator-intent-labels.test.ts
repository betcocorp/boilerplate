import { describe, expect, it } from 'vitest';

import {
  findOrchestratorIntentLabelByMessage,
  ORCHESTRATOR_INTENT_LABELS,
  plausibleAgentsForMessage,
} from './orchestrator-intent-labels';

/**
 * B0-652 — guards the prompt→label join the semantic-router eval depends on. If this lookup
 * silently misses, lenient (`plausible_agents`) grading degrades to strict everywhere and the
 * near-miss rows the dataset exists to expose stop being visible in the report.
 */
describe('findOrchestratorIntentLabelByMessage (B0-652)', () => {
  it('finds every row in the dataset by its own message', () => {
    const missing = ORCHESTRATOR_INTENT_LABELS.filter(
      (row) => findOrchestratorIntentLabelByMessage(row.message)?.id !== row.id,
    );
    expect(missing.map((row) => row.id)).toEqual([]);
  });

  it('tolerates padding and re-wrapped whitespace from a CSV round-trip', () => {
    const row = ORCHESTRATOR_INTENT_LABELS[0];
    const mangled = `  ${row.message.replace(/ /g, '  ').toUpperCase()}\n`;
    expect(findOrchestratorIntentLabelByMessage(mangled)?.id).toBe(row.id);
  });

  it('returns null for a prompt that is not in the golden set', () => {
    expect(findOrchestratorIntentLabelByMessage('какой-то незнакомый вопрос')).toBeNull();
    expect(plausibleAgentsForMessage('a prompt from some other suite entirely')).toBeNull();
  });

  it('always includes the intended agent in the plausible list it returns', () => {
    for (const row of ORCHESTRATOR_INTENT_LABELS) {
      expect(plausibleAgentsForMessage(row.message)).toContain(row.intended_agent);
    }
  });
});
