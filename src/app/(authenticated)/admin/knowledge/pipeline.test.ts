import { describe, expect, it } from 'vitest';

import { chunkMarkdown } from './pipeline';

describe('chunkMarkdown', () => {
  it('never emits a chunk with empty text', () => {
    const md = [
      '## Applications & Use Cases',
      '### Probiotic drains',
      'Pour 2 oz into the drain nightly.',
    ].join('\n');
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.text.trim().length > 0)).toBe(true);
  });

  it('folds a bare heading into the following content chunk', () => {
    const md = [
      '## Q: What causes recurring toilet bowl stains?',
      '## A: Root cause',
      'Hard water minerals deposit below the water line.',
    ].join('\n');
    const chunks = chunkMarkdown(md);
    // The empty "Q:" heading must not become its own chunk...
    expect(chunks.some((c) => c.text.trim() === '')).toBe(false);
    // ...and its text must ride along with the answer content.
    const joined = chunks.map((c) => c.text).join('\n');
    expect(joined).toContain('Q: What causes recurring toilet bowl stains?');
    expect(joined).toContain('Hard water minerals');
  });

  it('normal heading+body still produces one content chunk', () => {
    const chunks = chunkMarkdown('## Dilution\nUse 1:64 for daily cleaning.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe('Dilution');
    expect(chunks[0].text).toContain('1:64');
  });

  it('drops trailing content-less headings', () => {
    const chunks = chunkMarkdown('## Body\nSome content.\n## Dangling Heading With No Body');
    expect(chunks.every((c) => c.text.trim().length > 0)).toBe(true);
    expect(chunks).toHaveLength(1);
  });
});
