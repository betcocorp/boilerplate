import { describe, expect, it } from 'vitest';

import { FLOOR_WOOD_SPORT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-wood-sport-specialist-system-prompt';

/**
 * B0-1036..B0-1041 — the SportsZone Specialist (Less Complex) golden run
 * `53502489-9787-409b-89b3-f0b6f7a98e77` scored F on six wood/sport items because the answer was
 * missing a specific mandatory concept each time. These pin the prompt instructions that produce
 * those concepts so they cannot silently regress out of the policy.
 *
 * Regulated-data rule: the instructions are behavioural only — the prompt must never carry a
 * dilution, temperature, humidity, dry-time, or contact-time figure, so the assertions below check
 * phrasing, never values.
 */
describe('FLOOR_WOOD_SPORT_SPECIALIST_SYSTEM_PROMPT — golden-run concept gaps', () => {
  const prompt = FLOOR_WOOD_SPORT_SPECIALIST_SYSTEM_PROMPT;

  const recurringSection = prompt.slice(
    prompt.indexOf('# Recurring question types'),
    prompt.indexOf('# Boundaries'),
  );
  const answerShapeSection = prompt.slice(
    prompt.indexOf('# Answer shape (required)'),
    prompt.indexOf('# Recurring question types'),
  );

  it('B0-1036: requires the three-part recoat-timing verification, not the clock alone', () => {
    expect(recurringSection).toContain('"How long before I can put a second coat on / recoat over the last coat?"');
    expect(recurringSection).toContain('Lead with the three-part verification, never the clock alone');
    expect(recurringSection).toContain('the labeled minimum dry-to-recoat time for that product has elapsed');
    expect(recurringSection).toContain('the film is uniformly dry across the whole area');
    expect(recurringSection).toContain('the floor has returned to its documented moisture baseline');
    expect(recurringSection).toContain("direct the user to that coating's current TDS");
    // Kept distinct from the pre-existing recoat FREQUENCY bullet.
    expect(recurringSection).toContain('not the recoat FREQUENCY question above');
    expect(recurringSection).toContain('"How often should we recoat a gym/sport floor?"');
  });
});
