import { describe, expect, it } from 'vitest';

import {
  deriveKnowledgeDoc,
  docTypeFromKey,
  firstHeadingTitle,
  inferTitle,
  markdownToText,
  specialistFromKey,
  stripFrontmatter,
} from '~/lib/knowledge/discovery';

const P = 'v1-markdown-files/';

describe('specialistFromKey', () => {
  it('maps the real top folders to SME ids', () => {
    expect(specialistFromKey(`${P}restroom/safety-and-ppe.md`)).toBe('bathroom');
    expect(specialistFromKey(`${P}sportszone/Floor_Care_101_Wood.md`)).toBe('floor');
    expect(specialistFromKey(`${P}vct/Floor_Stripping_Guide.md`)).toBe('floor');
    expect(specialistFromKey(`${P}product/whatever.md`)).toBe('product');
    expect(specialistFromKey(`${P}mystery/x.md`)).toBeNull();
  });
});

describe('docTypeFromKey', () => {
  it('classifies by filename against real files', () => {
    expect(docTypeFromKey('floor-stripping-troubleshooting.md')).toBe('troubleshooting');
    expect(docTypeFromKey('Wood_Gym_Floor_FAQ_Guide.md')).toBe('faq');
    expect(docTypeFromKey('Betco_Glossary.md')).toBe('glossary');
    expect(docTypeFromKey('restroom-sanitation-workbook_full.md')).toBe('workbook');
    expect(docTypeFromKey('osha-hazcom-and-basic-chemistry_full.md')).toBe('workbook');
    expect(docTypeFromKey('how-to-select-a-vct-floor-finish.md')).toBe('howto');
    expect(docTypeFromKey('total-vs-nonvolatile-solids.md')).toBe('reference');
  });
});

describe('inferTitle', () => {
  it('title-cases a hyphen/underscore file name', () => {
    expect(inferTitle('remove-soap-scum-from-shower.md')).toBe('Remove Soap Scum From Shower');
    expect(inferTitle('Betco_Glossary.md')).toBe('Betco Glossary');
  });
});

describe('stripFrontmatter', () => {
  it('returns the body unchanged when there is no frontmatter (the v1 case)', () => {
    const raw = '# Title\n\nBody text.';
    expect(stripFrontmatter(raw)).toEqual({ frontmatter: {}, body: raw });
  });
  it('parses simple key: value frontmatter when present', () => {
    const raw = '---\ntitle: My Doc\nspecialist: floor\n---\n# H\n\nBody';
    const { frontmatter, body } = stripFrontmatter(raw);
    expect(frontmatter).toEqual({ title: 'My Doc', specialist: 'floor' });
    expect(body).toBe('# H\n\nBody');
  });
});

describe('firstHeadingTitle + markdownToText', () => {
  it('pulls the first H1', () => {
    expect(firstHeadingTitle('## sub\n# Real Title\nmore')).toBe('Real Title');
    expect(firstHeadingTitle('no heading here')).toBeNull();
  });
  it('strips markdown syntax to plain text', () => {
    const md = '# Heading\n\n- **bold** item\n- [link](https://x)\n\n`code`';
    const text = markdownToText(md);
    expect(text).toContain('bold item');
    expect(text).toContain('link');
    expect(text).not.toContain('#');
    expect(text).not.toContain('](');
  });
});

describe('deriveKnowledgeDoc', () => {
  it('derives title (first H1), specialist, doc-type, and body split', () => {
    const doc = deriveKnowledgeDoc({
      key: `${P}vct/floor-stripping-troubleshooting.md`,
      raw: '# Floor Stripping Troubleshooting\n\n## Issue\n\nStripper problems.',
    });
    expect(doc).toMatchObject({
      s3Key: `${P}vct/floor-stripping-troubleshooting.md`,
      title: 'Floor Stripping Troubleshooting',
      specialist: 'floor',
      docType: 'troubleshooting',
    });
    expect(doc.bodyMarkdown.startsWith('# Floor Stripping')).toBe(true);
    expect(doc.bodyText).toContain('Stripper problems');
  });
});
