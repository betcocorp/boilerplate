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

  it('B0-1037: requires measuring temperature and humidity with instruments, not by feel', () => {
    expect(recurringSection).toContain('"What temperature and humidity should the gym be at to coat the floor?"');
    expect(recurringSection).toContain(
      'MEASURE both with a calibrated thermometer and hygrometer in the space rather than judging conditions by feel',
    );
    expect(recurringSection).toContain('confirm the product-specific range on that coating\'s current TDS');
    expect(recurringSection).toContain('never give one from training knowledge');
  });

  it('B0-1038: gives the water-vs-solvent decision framework and closes on water-based', () => {
    expect(recurringSection).toContain('"Water-based or solvent-based — which type of finish do we want?"');
    expect(recurringSection).toContain('VOC and safety');
    expect(recurringSection).toContain('ambering/color change');
    expect(recurringSection).toContain('upfront cost versus long-term value across the recoat cycle');
    expect(recurringSection).toContain(
      'Betco and Basic Coatings offer and recommend water-based finishes for wood and sport floors',
    );
    expect(recurringSection).toContain('RETRIEVAL RETURNED');
    // B0-746 brand caution: no unverified sport-line product names may be hardcoded.
    for (const name of ['SportZone', 'SportsZone', 'Emulsion Pro', "Player's Choice", 'GymShoe', 'StreetShoe']) {
      expect(prompt).not.toContain(name);
    }
  });

  it('B0-1039: sequences scuff/ball-mark removal least-aggressive first and bans abrasives', () => {
    expect(recurringSection).toContain('"How do I get shoe scuffs, ball marks, or spots off the wood gym floor?"');
    expect(recurringSection).toContain('Sequence least-aggressive first');
    expect(recurringSection).toContain('changing to a clean cleaning surface often');
    expect(recurringSection).toContain('ONLY for ground-in marks the routine cleaner does not lift');
    expect(recurringSection).toContain("Remove spills as soon as they happen so liquid does not work into the floor's joints");
    expect(recurringSection).toContain(
      'Never recommend abrasive pads, abrasive screens, solvents, wax, or household cleaners to remove a mark from a finished wood gym floor',
    );
  });

  it('B0-1040: identifies the failed interface and refuses "just add another coat"', () => {
    expect(recurringSection).toContain('"What causes peeling or poor adhesion?"');
    expect(recurringSection).toContain('identify WHICH INTERFACE failed');
    expect(recurringSection).toContain('wood-to-sealer, sealer-to-paint (game lines), paint-to-finish, or old-finish-to-new-finish');
    expect(recurringSection).toContain('adding more clear coats over a failed bond does not fix it');

    expect(recurringSection).toContain('"Players say the wood gym floor feels slippery"');
    expect(recurringSection).toContain('Do not assume the floor needs another coat');
    expect(recurringSection).toContain('clean, appropriate athletic footwear');
    expect(recurringSection).toContain('whether the floor is fully dry before play after any cleaning');
  });

  it('B0-1041: promotes the applicator-switch caution to a required answer-shape line', () => {
    const caution =
      "don't switch applicator type (T-bar vs. roller) or pad/roller nap partway through the same area without first testing an inconspicuous spot";
    expect(answerShapeSection).toContain(
      '**The applicator-switch caution is a required line in any answer that covers applicator method, pad, or roller nap**',
    );
    expect(answerShapeSection).toContain(caution);
    expect(answerShapeSection).toContain('Finish an area with the tool it was started with.');
    // The caution now lives in exactly one place; the T-bar bullet points at it instead of repeating it.
    expect(recurringSection).not.toContain(caution);
    expect(recurringSection).toContain('The applicator-switch caution in **Answer shape (required)** is mandatory in this answer');
  });

  it('carries no regulated figure in any of the added instructions', () => {
    const addedShapes = [
      '"How long before I can put a second coat on / recoat over the last coat?"',
      '"What temperature and humidity should the gym be at to coat the floor?"',
      '"Water-based or solvent-based — which type of finish do we want?"',
      '"How do I get shoe scuffs, ball marks, or spots off the wood gym floor?"',
      '"What causes peeling or poor adhesion?"',
      '"Players say the wood gym floor feels slippery"',
    ];
    for (const shape of addedShapes) {
      const start = recurringSection.indexOf(shape);
      expect(start, `${shape} is present`).toBeGreaterThan(-1);
      const bullet = recurringSection.slice(start, recurringSection.indexOf('\n', start));
      expect(
        bullet,
        `${shape} must not hardcode a regulated value`,
      ).not.toMatch(/\d+\s*(?:°|degrees?|%|oz|ml|ppm|minutes?|hours?|days?)/i);
    }
  });
});
