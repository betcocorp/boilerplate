import { describe, expect, it } from 'vitest';

import { normalizeAgentMarkdownLists } from './markdown-normalize';

describe('normalizeAgentMarkdownLists', () => {
  it('joins a bare ordered-list marker back onto its bold label and nests following bullets', () => {
    const input = [
      '1.',
      '**Preparation:**',
      '- Sweep or dust mop the floor.',
      '- Move furniture out of the work area.',
      '2.',
      '**Application:**',
      '- Apply the finish in thin, even coats.',
    ].join('\n');

    const expected = [
      '1. **Preparation:**',
      '   - Sweep or dust mop the floor.',
      '   - Move furniture out of the work area.',
      '2. **Application:**',
      '   - Apply the finish in thin, even coats.',
    ].join('\n');

    expect(normalizeAgentMarkdownLists(input)).toBe(expected);
  });

  it('leaves already-well-formed markdown untouched (no-op on the common case)', () => {
    const input = [
      '1. **Preparation:** sweep the floor first.',
      '2. **Application:** apply the finish in thin coats.',
      '',
      'Regular paragraph text with no lists at all.',
    ].join('\n');

    expect(normalizeAgentMarkdownLists(input)).toBe(input);
  });

  it('does not treat a bare marker followed by a blank line as malformed', () => {
    const input = ['1.', '', 'Not a list label, just prose after a blank line.'].join('\n');

    expect(normalizeAgentMarkdownLists(input)).toBe(input);
  });
});
