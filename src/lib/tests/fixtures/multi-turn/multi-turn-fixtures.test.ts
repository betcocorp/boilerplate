import { readFileSync, readdirSync } from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { SME_AGENT_IDS } from '~/lib/agents/agent-registry';
import {
  multiTurnScenarioSetSchema,
  type MultiTurnScenarioSet,
} from '~/lib/tests/multi-turn';

/**
 * B0-539 — guards the authored multi-turn scenario sets in this directory.
 *
 * The suite globs the directory rather than importing a fixed list, so a newly added set file is
 * validated automatically instead of silently skipping CI.
 */

const FIXTURE_DIR = __dirname;

/** Authoring band from the ticket: 15–25 scenarios per SME agent. */
const MIN_SCENARIOS_PER_SET = 15;
const MAX_SCENARIOS_PER_SET = 25;

const setFileNames = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort();

function readSetFile(fileName: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, fileName), 'utf8'));
}

/** Every regulated-value shape that must never appear in an authored expectation. */
const REGULATED_VALUE_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'dilution ratio (e.g. 1:64)', pattern: /\b\d+\s*:\s*\d+\b/ },
  { label: 'oz per gallon', pattern: /\boz\b|\bounce/i },
  { label: 'mL or L per volume', pattern: /\bml\b|\bml\/l\b/i },
  { label: 'ppm', pattern: /\bppm\b/i },
  { label: 'percent concentration', pattern: /\d\s*%/ },
  { label: 'contact/dwell time in minutes or seconds', pattern: /\d+\s*(?:minute|min\b|second|sec\b)/i },
  { label: 'EPA registration number', pattern: /\b\d{3,6}-\d{1,4}(?:-\d{1,6})?\b/ },
  { label: 'CAS number', pattern: /\b\d{2,7}-\d{2}-\d\b/ },
  { label: 'log reduction value', pattern: /\blog\s*\d|\d+\s*log\b/i },
];

/**
 * Collects every string an evaluator will actually match against a response. Turn prompts and
 * author-facing `note`/`description` fields are excluded: a user is allowed to ASK for a regulated
 * value, and notes are never evaluated.
 */
function collectAssertedTerms(set: MultiTurnScenarioSet): Array<{ where: string; term: string }> {
  const terms: Array<{ where: string; term: string }> = [];

  for (const scenario of set.scenarios) {
    const scenarioLabel = scenario.scenario_id ?? scenario.title ?? '(unnamed scenario)';

    scenario.turns.forEach((turn, index) => {
      const expectations = turn.expectations;
      if (!expectations) return;
      const turnLabel = `${scenarioLabel} turn ${index + 1}`;
      for (const term of expectations.must_mention ?? []) {
        terms.push({ where: `${turnLabel} must_mention`, term });
      }
      for (const term of expectations.must_not_mention ?? []) {
        terms.push({ where: `${turnLabel} must_not_mention`, term });
      }
      if (expectations.expected_result_type) {
        terms.push({ where: `${turnLabel} expected_result_type`, term: expectations.expected_result_type });
      }
    });

    for (const assertion of scenario.assertions ?? []) {
      const label = `${scenarioLabel} ${assertion.type}`;
      switch (assertion.type) {
        case 'context_carry':
          terms.push({ where: `${label} anchor`, term: assertion.anchor });
          for (const alias of assertion.aliases ?? []) {
            terms.push({ where: `${label} aliases`, term: alias });
          }
          break;
        case 'no_reask':
          for (const provided of assertion.already_provided) {
            terms.push({ where: `${label} already_provided`, term: provided });
          }
          break;
        case 'consistent_product_anchor':
          terms.push({ where: `${label} product`, term: assertion.product });
          for (const alias of assertion.aliases ?? []) {
            terms.push({ where: `${label} aliases`, term: alias });
          }
          for (const disallowed of assertion.disallowed_products ?? []) {
            terms.push({ where: `${label} disallowed_products`, term: disallowed });
          }
          break;
        case 'mentions':
          for (const term of assertion.any_of) {
            terms.push({ where: `${label} any_of`, term });
          }
          break;
        case 'not_mentions':
          for (const term of assertion.none_of) {
            terms.push({ where: `${label} none_of`, term });
          }
          break;
      }
    }
  }

  return terms;
}

describe('multi-turn scenario fixtures (B0-539)', () => {
  it('finds at least one scenario set file', () => {
    expect(setFileNames.length).toBeGreaterThan(0);
  });

  describe.each(setFileNames)('%s', (fileName) => {
    const raw = readSetFile(fileName);
    const parsed = multiTurnScenarioSetSchema.safeParse(raw);

    it('parses against multiTurnScenarioSetSchema', () => {
      if (!parsed.success) {
        throw new Error(
          `${fileName} is not a valid multi-turn scenario set:\n${parsed.error.issues
            .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('\n')}`,
        );
      }
      expect(parsed.success).toBe(true);
    });

    it(`has ${MIN_SCENARIOS_PER_SET}–${MAX_SCENARIOS_PER_SET} scenarios`, () => {
      if (!parsed.success) return;
      expect(parsed.data.scenarios.length).toBeGreaterThanOrEqual(MIN_SCENARIOS_PER_SET);
      expect(parsed.data.scenarios.length).toBeLessThanOrEqual(MAX_SCENARIOS_PER_SET);
    });

    it('gives every scenario a unique scenario_id and a title', () => {
      if (!parsed.success) return;
      const ids = parsed.data.scenarios.map((scenario) => scenario.scenario_id);
      expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
      expect(
        parsed.data.scenarios.every(
          (scenario) => typeof scenario.title === 'string' && scenario.title.length > 0,
        ),
      ).toBe(true);
    });

    it('exercises something a single-turn test cannot (assertions or a later-turn expectation)', () => {
      if (!parsed.success) return;
      for (const scenario of parsed.data.scenarios) {
        const hasAssertions = (scenario.assertions ?? []).length > 0;
        const hasLaterTurnExpectation = scenario.turns
          .slice(1)
          .some((turn) => turn.expectations !== undefined);
        expect(
          hasAssertions || hasLaterTurnExpectation,
          `${scenario.scenario_id ?? scenario.title} has no cross-turn assertion and no expectation past turn 1`,
        ).toBe(true);
      }
    });

    it('never asserts a regulated value in an evaluated field', () => {
      if (!parsed.success) return;
      const offenders = collectAssertedTerms(parsed.data).flatMap(({ where, term }) =>
        REGULATED_VALUE_PATTERNS.filter(({ pattern }) => pattern.test(term)).map(
          ({ label }) => `${where}: "${term}" looks like a ${label}`,
        ),
      );
      expect(offenders, offenders.join('\n')).toEqual([]);
    });
  });

  it('declares a unique set_id per file and a valid intended_agent', () => {
    const setIds = new Set<string>();
    for (const fileName of setFileNames) {
      const parsed = multiTurnScenarioSetSchema.safeParse(readSetFile(fileName));
      expect(parsed.success, `${fileName} failed to parse`).toBe(true);
      if (!parsed.success) continue;
      expect(setIds.has(parsed.data.set_id), `duplicate set_id ${parsed.data.set_id}`).toBe(false);
      setIds.add(parsed.data.set_id);
      expect(SME_AGENT_IDS).toContain(parsed.data.intended_agent);
    }
  });

  it('covers every SME agent exactly once', () => {
    const byAgent = new Map<string, string>();
    for (const fileName of setFileNames) {
      const parsed = multiTurnScenarioSetSchema.safeParse(readSetFile(fileName));
      if (!parsed.success) continue;
      expect(
        byAgent.has(parsed.data.intended_agent),
        `${parsed.data.intended_agent} already covered by ${byAgent.get(parsed.data.intended_agent)}`,
      ).toBe(false);
      byAgent.set(parsed.data.intended_agent, fileName);
    }
    expect([...byAgent.keys()].sort()).toEqual([...SME_AGENT_IDS].sort());
  });
});
