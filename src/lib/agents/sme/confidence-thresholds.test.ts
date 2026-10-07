import { describe, expect, it } from 'vitest';

import { BATHROOM_SPECIALIST_SYSTEM_PROMPT as SME_BATHROOM_SYSTEM_PROMPT } from '~/lib/agents/bathroom-specialist/bathroom-specialist-system-prompt';
import { CROSS_REFERENCE_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/cross-reference-specialist/cross-reference-specialist-system-prompt';
import { DILUTION_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/dilution-specialist/dilution-specialist-system-prompt';
import { FLOOR_CONCRETE_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-concrete-specialist-system-prompt';
import { FLOOR_STG_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-stg-specialist-system-prompt';
import { FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-vct-specialist-system-prompt';
import { FLOOR_WOOD_SPORT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/floor-specialist/floor-wood-sport-specialist-system-prompt';
import { PRODUCT_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/product-specialist/product-specialist-system-prompt';
import { RECOMMENDATIONS_SPECIALIST_SYSTEM_PROMPT } from '~/lib/agents/recommendations-specialist/recommendations-specialist-system-prompt';
import {
  CONFIDENCE_GATED_PROMPT_IDS,
  SME_CONFIDENCE_THRESHOLDS,
  confidenceGateClause,
  confidenceThreshold,
  formatConfidenceThreshold,
  type ConfidenceGatedPromptId,
} from '~/lib/agents/sme/confidence-thresholds';
import {
  BATHROOM_SPECIALIST_SYSTEM_PROMPT as WORKFLOW_BATHROOM_SYSTEM_PROMPT,
  EFFECTIVE_PROMPT_IDS,
} from '~/lib/workflows/product-support/product-support-prompts';

/**
 * B0-530 — the exact sentence each prompt is expected to render. These are written out longhand
 * (not built from the shared helper) on purpose: if someone edits the shared constant, these
 * assertions must fail rather than move with it.
 */
const EXPECTED_THRESHOLD_SENTENCE: Record<string, { prompt: string; sentence: string }> = {
  // B0-352 — one bathroom prompt; the SME route and the workflow import the same text.
  bathroom: {
    prompt: WORKFLOW_BATHROOM_SYSTEM_PROMPT,
    sentence:
      '- If confidence is below **0.8**, use the decline response below. Do not attempt to answer.',
  },
  dilution: {
    prompt: DILUTION_SPECIALIST_SYSTEM_PROMPT,
    sentence:
      'If confidence is below **0.9**, say so and arrange human follow-up rather than speculating.',
  },
  floor_wood_sport: {
    prompt: FLOOR_WOOD_SPORT_SPECIALIST_SYSTEM_PROMPT,
    sentence:
      'If confidence is below **0.9**, avoid definitive process guarantees and trigger human follow-up.',
  },
  floor_concrete: {
    prompt: FLOOR_CONCRETE_SPECIALIST_SYSTEM_PROMPT,
    sentence:
      'If confidence is below **0.9**, avoid definitive process guarantees and trigger human follow-up.',
  },
  floor_stg: {
    prompt: FLOOR_STG_SPECIALIST_SYSTEM_PROMPT,
    sentence:
      'If confidence is below **0.9**, avoid definitive process guarantees and trigger human follow-up.',
  },
  floor_vct: {
    prompt: FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT,
    sentence:
      'If confidence is below **0.9**, avoid definitive process guarantees and trigger human follow-up.',
  },
  product: {
    prompt: PRODUCT_SPECIALIST_SYSTEM_PROMPT,
    sentence:
      'When confidence is below **0.9**, trigger human follow-up (for example an escalation or ticket) in addition to your reply, and say that a representative may follow up.',
  },
  recommendations: {
    prompt: RECOMMENDATIONS_SPECIALIST_SYSTEM_PROMPT,
    sentence:
      '- If confidence is below **0.8**, do not present a definitive recommendation. Reply **exactly**:',
  },
};

describe('SME confidence thresholds (B0-530)', () => {
  it('keeps every gated prompt on the threshold it shipped with', () => {
    for (const [label, { prompt, sentence }] of Object.entries(EXPECTED_THRESHOLD_SENTENCE)) {
      expect(prompt, `${label} must state its threshold verbatim`).toContain(sentence);
    }
  });

  it('states each threshold exactly once per prompt', () => {
    for (const [label, { prompt, sentence }] of Object.entries(EXPECTED_THRESHOLD_SENTENCE)) {
      expect(prompt.split(sentence).length - 1, `${label} states its gate once`).toBe(1);
    }
  });

  it('leaves no hardcoded threshold literal outside the shared module', () => {
    // Every "confidence is below **N**" in a prompt must be one of the sentences above, so a new
    // hardcoded literal cannot slip in unnoticed.
    for (const [label, { prompt }] of Object.entries(EXPECTED_THRESHOLD_SENTENCE)) {
      const matches = prompt.match(/confidence is below \*\*[\d.]+\*\*/g) ?? [];
      expect(matches.length, `${label} has exactly one confidence gate`).toBe(1);
    }
  });

  it('exposes a threshold for every gated id and nothing else', () => {
    expect(Object.keys(SME_CONFIDENCE_THRESHOLDS).sort()).toEqual(
      [...CONFIDENCE_GATED_PROMPT_IDS].sort(),
    );
    for (const id of CONFIDENCE_GATED_PROMPT_IDS) {
      expect(confidenceThreshold(id)).toBeGreaterThan(0);
      expect(confidenceThreshold(id)).toBeLessThanOrEqual(1);
    }
  });

  it('renders the threshold without trailing-zero padding', () => {
    expect(formatConfidenceThreshold('bathroom')).toBe('**0.8**');
    expect(formatConfidenceThreshold('product')).toBe('**0.9**');
    expect(confidenceGateClause('floor_vct')).toBe('If confidence is below **0.9**');
    expect(confidenceGateClause('product', { lead: 'When' })).toBe(
      'When confidence is below **0.9**',
    );
  });

  it('gates only ids the product-support workflow actually runs', () => {
    for (const id of CONFIDENCE_GATED_PROMPT_IDS) {
      expect(EFFECTIVE_PROMPT_IDS as readonly string[]).toContain(id);
    }
  });

  it('keeps a single bathroom prompt shared by the SME route and the workflow (B0-352)', () => {
    expect(SME_BATHROOM_SYSTEM_PROMPT).toBe(WORKFLOW_BATHROOM_SYSTEM_PROMPT);
    expect(SME_BATHROOM_SYSTEM_PROMPT).toContain('# Tool use (mandatory)');
    expect(SME_BATHROOM_SYSTEM_PROMPT).not.toContain('escalation_specialist');
  });

  it('excludes cross_reference, whose gate is qualitative rather than numeric', () => {
    expect(CONFIDENCE_GATED_PROMPT_IDS as readonly string[]).not.toContain('cross_reference');
    expect(CROSS_REFERENCE_SPECIALIST_SYSTEM_PROMPT).not.toMatch(/confidence is below \*\*[\d.]+\*\*/);
  });
});

/** Compile-time guard: every gated id is a real product-support prompt id. */
const _gatedIdsAreEffectivePromptIds: readonly (typeof EFFECTIVE_PROMPT_IDS)[number][] =
  CONFIDENCE_GATED_PROMPT_IDS satisfies readonly ConfidenceGatedPromptId[];
void _gatedIdsAreEffectivePromptIds;
