import { describe, expect, it } from 'vitest';

import { chunkMarkdownByHeadings } from '~/lib/knowledge/chunker';

const SAMPLE = `# Floor Stripping Troubleshooting

Intro paragraph under the title.

## Common Causes

### Dwell Time Is Too Short

Strippers need time to break the bond.

### Too Much Buildup

Floors may have 20+ coats.
`;

describe('chunkMarkdownByHeadings', () => {
  it('splits on headings and tracks the ancestor section path', () => {
    const chunks = chunkMarkdownByHeadings(SAMPLE);
    // Sections with body: title intro, Dwell Time, Too Much Buildup ("Common Causes" has no direct body).
    expect(chunks).toHaveLength(3);

    expect(chunks[0].heading).toBe('Floor Stripping Troubleshooting');
    expect(chunks[0].sectionPath).toEqual(['Floor Stripping Troubleshooting']);
    expect(chunks[0].text).toContain('Intro paragraph');

    const dwell = chunks[1];
    expect(dwell.heading).toBe('Dwell Time Is Too Short');
    expect(dwell.sectionPath).toEqual([
      'Floor Stripping Troubleshooting',
      'Common Causes',
      'Dwell Time Is Too Short',
    ]);
    // Breadcrumb prepended so the chunk is self-descriptive for embedding.
    expect(dwell.text.startsWith('Floor Stripping Troubleshooting > Common Causes > Dwell Time Is Too Short')).toBe(true);
    expect(dwell.text).toContain('break the bond');
  });

  it('assigns sequential indices', () => {
    const chunks = chunkMarkdownByHeadings(SAMPLE);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it('splits an over-long section on paragraph boundaries', () => {
    const big = `# H\n\n${'a'.repeat(1500)}\n\n${'b'.repeat(1500)}`;
    const chunks = chunkMarkdownByHeadings(big, { maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.heading === 'H')).toBe(true);
  });

  it('returns nothing for headingless whitespace', () => {
    expect(chunkMarkdownByHeadings('   \n\n  ')).toEqual([]);
  });
});
