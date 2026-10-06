import { describe, expect, it } from 'vitest';

import { resolveReportCategory, UNCATEGORIZED_CATEGORY } from './report-category';

describe('resolveReportCategory (B0-853)', () => {
  it('prefers the human-authored question_category from the import payload', () => {
    expect(
      resolveReportCategory({
        input_payload: { question_category: 'Efficacy and Pathogen Claims' },
        prompt_category: 'pathogen-specific',
      }),
    ).toBe('Efficacy and Pathogen Claims');
  });

  it('trims surrounding whitespace but never re-cases or slugifies the label', () => {
    expect(
      resolveReportCategory({
        input_payload: { question_category: '  Product Cross-Reference ' },
        prompt_category: 'competitor',
      }),
    ).toBe('Product Cross-Reference');
  });

  it('falls back to prompt_category when the payload carries no question_category', () => {
    expect(resolveReportCategory({ input_payload: {}, prompt_category: 'dilution' })).toBe(
      'dilution',
    );
  });

  it('treats a whitespace-only question_category as absent', () => {
    expect(
      resolveReportCategory({
        input_payload: { question_category: '   ' },
        prompt_category: 'recommendation',
      }),
    ).toBe('recommendation');
  });

  it('treats an empty or null question_category as absent', () => {
    expect(
      resolveReportCategory({ input_payload: { question_category: '' }, prompt_category: 'x' }),
    ).toBe('x');
    expect(
      resolveReportCategory({ input_payload: { question_category: null }, prompt_category: 'x' }),
    ).toBe('x');
  });

  it('returns Uncategorized when both sources are absent', () => {
    expect(resolveReportCategory({ input_payload: {}, prompt_category: null })).toBe(
      UNCATEGORIZED_CATEGORY,
    );
    expect(resolveReportCategory({ input_payload: null, prompt_category: '  ' })).toBe(
      UNCATEGORIZED_CATEGORY,
    );
  });

  it('never throws on a payload that is not an object or carries a non-string value', () => {
    expect(resolveReportCategory({ input_payload: 'nope', prompt_category: 'a' })).toBe('a');
    expect(resolveReportCategory({ input_payload: [1, 2], prompt_category: 'b' })).toBe('b');
    expect(
      resolveReportCategory({ input_payload: { question_category: 42 }, prompt_category: 'c' }),
    ).toBe('c');
  });
});
