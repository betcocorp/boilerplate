import { describe, expect, it } from 'vitest';

import {
  DILUTION_DWELL_BACKSTOP_SENTENCE,
  applyDilutionDwellBackstop,
  draftMentionsDisinfectantDwell,
  draftStatesVisiblyWetDwell,
  isDilutionSystemHowToQuestion,
} from '~/lib/workflows/product-support/dilution-dwell-backstop';

/** Dilution golden `ce445e69` — the prompt this backstop exists for. */
const GOLDEN_PROMPT = 'How do employees use the dilution system to prepare disinfectant correctly?';

/** The scored-59 answer: mentions dwell time but never the visibly-wet rule. */
const OMITTING_DRAFT =
  'Employees should select the disinfectant setting on the dispenser and fill the bottle. ' +
  'Dwell time is non-negotiable for disinfectants — always allow the labeled contact time before wiping.';

describe('isDilutionSystemHowToQuestion (B0-1002)', () => {
  it('matches the golden employee-use prompt', () => {
    expect(isDilutionSystemHowToQuestion(GOLDEN_PROMPT)).toBe(true);
  });

  it.each([
    'How should staff calibrate the dispenser for the disinfectant setting?',
    'What is the proper way to train new employees on the dilution control system?',
    'How do I set up the FastDraw dispenser for disinfectant?',
  ])('matches dilution-system how-to phrasing: %s', (message) => {
    expect(isDilutionSystemHowToQuestion(message)).toBe(true);
  });

  it.each([
    'What kills norovirus in a school restroom?',
    'What is the dilution ratio for GC Disinfectant?',
    '',
  ])('does not match a bare pathogen-recommendation or dilution-value ask: %s', (message) => {
    expect(isDilutionSystemHowToQuestion(message)).toBe(false);
  });
});

describe('draftMentionsDisinfectantDwell (B0-1002)', () => {
  it('detects a dwell/contact-time mention paired with disinfectant', () => {
    expect(draftMentionsDisinfectantDwell(OMITTING_DRAFT)).toBe(true);
  });

  it('does not fire when the draft never discusses disinfectant dwell', () => {
    expect(
      draftMentionsDisinfectantDwell('Select the correct metering tip and fill the bottle per the chart.'),
    ).toBe(false);
  });
});

describe('draftStatesVisiblyWetDwell (B0-1002)', () => {
  it('does not treat "dwell time is non-negotiable" as stating the rule', () => {
    expect(draftStatesVisiblyWetDwell(OMITTING_DRAFT)).toBe(false);
  });

  it('recognises the rule when already stated', () => {
    expect(
      draftStatesVisiblyWetDwell(
        'The surface must stay visibly wet for the entire labeled contact time; reapply if it dries early.',
      ),
    ).toBe(true);
    expect(
      draftStatesVisiblyWetDwell('Keep the surface wet for the full labeled contact time.'),
    ).toBe(true);
  });
});

describe('applyDilutionDwellBackstop (B0-1002)', () => {
  it('appends the canonical sentence to the golden omitting draft', () => {
    const result = applyDilutionDwellBackstop({ userMessage: GOLDEN_PROMPT, draftAnswer: OMITTING_DRAFT });
    expect(result.applied).toBe(true);
    expect(result.answer).toContain(OMITTING_DRAFT);
    expect(result.answer).toContain(DILUTION_DWELL_BACKSTOP_SENTENCE);
  });

  it('is additive — never removes existing draft content', () => {
    const result = applyDilutionDwellBackstop({ userMessage: GOLDEN_PROMPT, draftAnswer: OMITTING_DRAFT });
    expect(result.answer.startsWith(OMITTING_DRAFT)).toBe(true);
  });

  it('does not fire for a non-dilution-system question', () => {
    const result = applyDilutionDwellBackstop({
      userMessage: 'What kills norovirus in a school restroom?',
      draftAnswer: OMITTING_DRAFT,
    });
    expect(result.applied).toBe(false);
    expect(result.answer).toBe(OMITTING_DRAFT);
  });

  it('does not fire when the draft never discusses disinfectant dwell at all', () => {
    const result = applyDilutionDwellBackstop({
      userMessage: GOLDEN_PROMPT,
      draftAnswer: 'Select the correct metering tip for the concentrate and verify the dilution visually.',
    });
    expect(result.applied).toBe(false);
  });

  it('does not fire when the draft already states the rule', () => {
    const draft =
      'Employees should select the disinfectant setting. The surface must stay visibly wet for the ' +
      'entire labeled contact time; if it dries early, reapply rather than shortening the time.';
    const result = applyDilutionDwellBackstop({ userMessage: GOLDEN_PROMPT, draftAnswer: draft });
    expect(result.applied).toBe(false);
    expect(result.answer).toBe(draft);
  });

  it('does not fire on an empty draft', () => {
    const result = applyDilutionDwellBackstop({ userMessage: GOLDEN_PROMPT, draftAnswer: '   ' });
    expect(result.applied).toBe(false);
  });

  it('states no dilution ratio or contact-time figure of its own', () => {
    expect(DILUTION_DWELL_BACKSTOP_SENTENCE).not.toMatch(/\d+\s*(?:oz|ml|%|minutes?|seconds?)\b/i);
  });
});
