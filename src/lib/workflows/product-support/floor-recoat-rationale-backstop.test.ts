import { describe, expect, it } from 'vitest';

import { FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-vct-specialist-system-prompt';
import {
  FLOOR_RECOAT_RATIONALE_SENTENCE,
  applyFloorRecoatRationaleBackstop,
  draftAnswersRecoatTiming,
  draftStatesTopDownRationale,
  isRecoatTimingQuestion,
} from '~/lib/workflows/product-support/floor-recoat-rationale-backstop';
import { evaluateRegulatedClaimGrounding } from '~/lib/workflows/product-support/validator';

/**
 * B0-1033 — VCT Top 20 run `844f8eb3` row 6 (`e324a252-bff3-4091-9a16-012be23b75f9`, scored 59).
 * Prompt and answer below are the real `workflow_runs` values, verbatim: the answer gave the
 * documented timing and cited the right document, and dropped the mandatory WHY.
 */
const GOLDEN_PROMPT = 'How long should VCT  finish dry between coats?';
const SHIPPED_ANSWER = `Allow **20 minutes up to 1 hour** between VCT finish coats.

- Ensure each coat is **dry to the touch, then wait an additional 15 minutes** before applying the next coat.
- Best conditions: about **20 minutes**; poor airflow or high humidity: up to **60 minutes**.
- Keep all traffic off the floor between coats.

**Caveat:** Dry time varies with temperature, humidity, and airflow; follow the specific finish label if it requires a different interval.

Source: Betco *VCT Finish Application—Coats, Drying and Curing* procedure [doc:1d904b83-6f7d-49ea-a568-1e5992f048bd].`;

describe('isRecoatTimingQuestion (B0-1033)', () => {
  it.each([
    GOLDEN_PROMPT,
    'How long before the next coat of VCT finish?',
    'what is the recoat window on a VCT floor',
    'how long do I wait between coats of floor finish',
  ])('matches the recoat-timing ask: %s', (message) => {
    expect(isRecoatTimingQuestion(message)).toBe(true);
  });

  it.each([
    'How soon can people walk on the VCT floor after the last coat?',
    'How many coats of finish does VCT need?',
    'How long should the disinfectant dwell on the counter?',
    '',
  ])('does not match: %s', (message) => {
    expect(isRecoatTimingQuestion(message)).toBe(false);
  });
});

describe('draftAnswersRecoatTiming / draftStatesTopDownRationale (B0-1033)', () => {
  it('sees that the shipped answer stated the timing', () => {
    expect(draftAnswersRecoatTiming(SHIPPED_ANSWER)).toBe(true);
  });

  it('sees that the shipped answer omitted the rationale — the whole finding of this ticket', () => {
    expect(draftStatesTopDownRationale(SHIPPED_ANSWER)).toBe(false);
  });

  it('recognises the rationale in the model\'s own wording, so a good answer is not double-patched', () => {
    for (const draft of [
      'Wait 15 minutes after it is dry to the touch between coats, because finish dries top-down.',
      'Allow 20 minutes between coats; the surface can feel dry while moisture is still trapped underneath.',
      'Give it an hour between coats — drying happens from the top down, trapping moisture below.',
    ]) {
      expect(draftStatesTopDownRationale(draft)).toBe(true);
    }
  });

  it('does not treat a clarifying question or a coat count as a timing answer', () => {
    expect(draftAnswersRecoatTiming('Which Betco finish are you applying?')).toBe(false);
    expect(draftAnswersRecoatTiming('Apply 4 coats of finish between scrubs.')).toBe(false);
  });
});

describe('applyFloorRecoatRationaleBackstop (B0-1033)', () => {
  const base = {
    userMessage: GOLDEN_PROMPT,
    effectivePromptId: 'floor_vct',
    draftAnswer: SHIPPED_ANSWER,
  };

  it('restores the rationale to the answer that shipped without it', () => {
    const result = applyFloorRecoatRationaleBackstop(base);
    expect(result.applied).toBe(true);
    expect(result.answer).toContain('dries from the top down');
    expect(result.answer).toContain('trapped underneath');
    expect(draftStatesTopDownRationale(result.answer)).toBe(true);
  });

  it('is additive: every line of the original answer survives, in order', () => {
    const result = applyFloorRecoatRationaleBackstop(base);
    for (const line of SHIPPED_ANSWER.split('\n').filter((l) => l.trim())) {
      expect(result.answer).toContain(line);
    }
    expect(result.answer.indexOf('Allow **20 minutes')).toBeLessThan(
      result.answer.indexOf(FLOOR_RECOAT_RATIONALE_SENTENCE),
    );
  });

  it('splices the rationale ABOVE the closing Source line', () => {
    const result = applyFloorRecoatRationaleBackstop(base);
    expect(result.answer.indexOf(FLOOR_RECOAT_RATIONALE_SENTENCE)).toBeLessThan(
      result.answer.indexOf('Source: Betco'),
    );
  });

  it('appends at the end when the answer has no Source block', () => {
    const draftAnswer = 'Allow 20 minutes up to 1 hour between coats.';
    const result = applyFloorRecoatRationaleBackstop({ ...base, draftAnswer });
    expect(result.answer).toBe(`${draftAnswer}\n\n${FLOOR_RECOAT_RATIONALE_SENTENCE}`);
  });

  it('is a no-op when the draft already carries the rationale', () => {
    const draftAnswer = `${SHIPPED_ANSWER}\n\nFinish dries top-down, so moisture can be trapped underneath.`;
    const result = applyFloorRecoatRationaleBackstop({ ...base, draftAnswer });
    expect(result.applied).toBe(false);
    expect(result.answer).toBe(draftAnswer);
  });

  it('is a no-op off the floor routes, off the question type, and on an empty draft', () => {
    expect(applyFloorRecoatRationaleBackstop({ ...base, effectivePromptId: 'product' }).applied).toBe(
      false,
    );
    expect(applyFloorRecoatRationaleBackstop({ ...base, effectivePromptId: null }).applied).toBe(
      false,
    );
    expect(
      applyFloorRecoatRationaleBackstop({
        ...base,
        userMessage: 'How soon can people walk on the VCT floor after the last coat?',
      }).applied,
    ).toBe(false);
    expect(applyFloorRecoatRationaleBackstop({ ...base, draftAnswer: '   ' }).applied).toBe(false);
  });

  it('applies on every floor substrate route', () => {
    for (const route of ['floor_vct', 'floor_wood_sport', 'floor_concrete', 'floor_stg']) {
      expect(
        applyFloorRecoatRationaleBackstop({ ...base, effectivePromptId: route }).applied,
      ).toBe(true);
    }
  });
});

describe('FLOOR_RECOAT_RATIONALE_SENTENCE — regulated-data and prompt parity (B0-1033)', () => {
  it('states no figure of any kind', () => {
    expect(FLOOR_RECOAT_RATIONALE_SENTENCE).not.toMatch(/\d/);
  });

  it('trips no regulated-claim category, so it can never fail the guardrail it is swept through', () => {
    const { categoriesDetected } = evaluateRegulatedClaimGrounding({
      draftAnswer: FLOOR_RECOAT_RATIONALE_SENTENCE,
      sources: [],
    });
    expect(categoriesDetected).toEqual([]);
  });

  it('says the same thing the VCT prompt bullet mandates', () => {
    expect(FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT).toContain('finish dries top-down');
    expect(FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT).toContain(
      'Do not drop this rationale even when the user only asked for the timing figures',
    );
    expect(FLOOR_RECOAT_RATIONALE_SENTENCE).toContain('dries from the top down');
  });
});
