import { describe, expect, it } from 'vitest';

import { floorToolUseMandatoryClause } from '~/lib/agents/floor-specialist/floor-shared-prompt';
import {
  FLOOR_VCT_PROCEDURE_QUERIES,
  FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT,
} from '~/lib/agents/floor-specialist/floor-vct-specialist-system-prompt';
import { clarifyBeforeRecommendClause } from '~/lib/agents/sme/clarify-before-recommend';
import { productSupportTools } from '~/lib/tools/definitions';

/**
 * B0-976 — VCT golden `339b3004` ("how soon can people walk on the VCT floor after the last coat?")
 * was answered with a request for the finish name, or from the between-coats document. These pin
 * the prompt text that tells the model the reopening schedule is a knowledge-document answer given
 * FIRST, with the label refinement offered rather than required.
 */
describe('FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT — reopening to traffic (B0-976)', () => {
  const prompt = FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT;

  it('has a recurring question type for reopening / walk-on after the final coat', () => {
    expect(prompt).toMatch(/"When can we reopen \/ walk on \/ put carts and furniture back after the final coat\?"/);
  });

  it('routes the reopening question to get_floor_asset with the reopening procedure', () => {
    expect(prompt).toContain('Call `get_floor_asset` FIRST with the procedure "reopening to traffic after final coat"');
  });

  it('gives the knowledge-base schedule first and names every tier without embedding a figure', () => {
    expect(prompt).toContain('dry-to-touch, light foot traffic, normal foot traffic, heavy or rolling loads');
    expect(prompt).toContain('each figure exactly as written');
    // Regulated/transcription rule: the prompt names the tiers, never a number for them.
    const reopenBullet = prompt.slice(prompt.indexOf('"When can we reopen'), prompt.indexOf('"Is X better than Y?"'));
    expect(reopenBullet).not.toMatch(/\d+\s*(?:–|-|to)?\s*\d*\s*(?:minutes?|hours?)/i);
  });

  it('quotes the label-defers caveat and OFFERS the label refinement instead of requiring it', () => {
    expect(prompt).toContain("quote its caveat that the specific finish's label governs");
    expect(prompt).toContain('OFFER the label-specific refinement');
    expect(prompt).toContain('Never withhold the general schedule pending a product name');
    expect(prompt).toContain('never replace it with a clarifying question');
  });

  it('lets dry/cure/reopen timing come from the label OR the floor-care knowledge document', () => {
    expect(prompt).toContain(
      'Dry, cure, recoat, and reopen-to-traffic timing may come from the product label OR from the floor-care knowledge document `get_floor_asset` returns',
    );
    // The old bullet framed dry/recoat time as a label-only product value; that framing is gone.
    expect(prompt).not.toContain('coverage, coat count, dry/recoat time, each attributed');
  });

  it('keeps the shared "not on file rather than estimating" guardrail', () => {
    expect(prompt).toContain('say the documented procedure is not on file rather than estimating one');
    expect(prompt).toContain('do not estimate one');
  });
});

/**
 * B0-1031 — VCT Top 20 run `844f8eb3` rows 2/3/11 were answered with a request for the product name
 * and no documented benchmark, and `get_floor_asset` was never called. These pin the prompt half of
 * the fix, which works regardless of the `BEX_FACT_TOOL_ENFORCEMENT_ENABLED` lever.
 */
describe('FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT — procedure/benchmark question types (B0-1031)', () => {
  const prompt = FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT;

  it('has a question type for stripper dwell, stripping failure, and finish appearance problems', () => {
    expect(prompt).toMatch(/"How long should the stripper dwell before I scrub\?"/);
    expect(prompt).toMatch(/"Why didn't all the finish come off when I stripped\?"/);
    expect(prompt).toContain('powdering, flaking, peeling, adhesion failure');
  });

  it('routes each of them to get_floor_asset with its canonical procedure string', () => {
    for (const procedure of [
      FLOOR_VCT_PROCEDURE_QUERIES.stripperDwell,
      FLOOR_VCT_PROCEDURE_QUERIES.strippingFailure,
      FLOOR_VCT_PROCEDURE_QUERIES.finishAppearanceProblem,
    ]) {
      expect(prompt).toContain(`Call \`get_floor_asset\` FIRST with the procedure "${procedure}"`);
    }
  });

  it('stops each of them opening with a product-identity clarifying question', () => {
    expect(prompt).toContain('Do NOT open by asking which stripper is in use');
    expect(prompt).toContain('Do NOT open by asking which stripper was used');
    expect(prompt).toContain('Never open with the clarifying question');
  });

  it('embeds no dwell figure in the bullets this ticket added', () => {
    const dwellBullet = prompt.slice(
      prompt.indexOf('"How long should the stripper dwell'),
      prompt.indexOf('- **Multi-part questions**'),
    );
    expect(dwellBullet).not.toMatch(/\d+\s*(?:–|-|to)?\s*\d*\s*(?:minutes?|hours?)/i);
  });
});

describe('floorToolUseMandatoryClause — get_floor_asset is required, not advisory (B0-1031)', () => {
  it('says search_product_docs does not satisfy the requirement for procedure questions', () => {
    const clause = floorToolUseMandatoryClause('VCT, terrazzo, or resilient/hard tile floor care');
    expect(clause).toContain('`get_floor_asset` is REQUIRED, not optional');
    expect(clause).toContain('Calling `search_product_docs` does NOT satisfy that requirement');
    // Phrased conditionally on purpose: this clause renders into all four substrate prompts, and
    // only the VCT one currently names exact `procedure` phrases in its bullets (B0-1031 audit).
    expect(clause).toContain('Where a question-type bullet below names an exact `procedure` phrase');
    expect(clause).toContain('one procedure per call');
  });

  it('stays substrate-neutral — it renders into all four substrate prompts', () => {
    for (const substrate of [
      'VCT, terrazzo, or resilient/hard tile floor care',
      'wood or sport/gym floor care',
      'concrete floor care',
      'stone, tile, or grout cleaning or protection',
    ]) {
      const clause = floorToolUseMandatoryClause(substrate);
      expect(clause).toContain(substrate);
      // The added paragraphs name question SHAPES, never one substrate's content.
      expect(clause.split('`get_floor_asset` is REQUIRED')[1]).not.toMatch(
        /\bVCT\b|\bterrazzo\b|\bgym\b|\bgrout\b/i,
      );
    }
  });

  it('is interpolated into the VCT prompt', () => {
    expect(FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT).toContain(
      floorToolUseMandatoryClause('VCT, terrazzo, or resilient/hard tile floor care'),
    );
  });
});

describe('clarifyBeforeRecommendClause — reopening is not a product-identity ask (B0-976)', () => {
  it.each(['#', '##'] as const)('excludes floor timing questions from the identity trigger (%s)', (heading) => {
    const clause = clarifyBeforeRecommendClause(heading);
    expect(clause).toContain('reopen-to-traffic timing question');
    expect(clause).toContain("is NOT a regulated-value ask and does not need the product's identity");
    expect(clause).toContain('offer — never require — a label-specific figure');
  });

  it('is interpolated into the VCT prompt', () => {
    expect(FLOOR_VCT_SPECIALIST_SYSTEM_PROMPT).toContain(clarifyBeforeRecommendClause('#'));
  });
});

describe('get_floor_asset tool description — reopening phrasing (B0-976)', () => {
  it('names the reopening question in USE WHEN and the procedure query to send', () => {
    const tool = productSupportTools.find((t) => t.name === 'get_floor_asset');
    expect(tool).toBeDefined();
    const description = (tool as { description?: string }).description ?? '';
    expect(description).toContain('when can we reopen / walk on the floor / put carts back after the final coat');
    expect(description).toContain('pass procedure "reopening to traffic after final coat"');
  });
});
