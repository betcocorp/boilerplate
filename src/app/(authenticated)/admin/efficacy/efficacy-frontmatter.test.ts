import { describe, expect, it } from 'vitest';

import { parseEfficacyFrontmatter } from './efficacy-frontmatter';

// A verbatim hygiene/skin-care efficacy document header as it exists in
// s3://retool-360/efficacy/markdown/hygiene-skin-care/**, plus the result
// tables B0-797 appends underneath.
const DOCUMENT = `---
formula_code: M000759
product_name: Clario Ultrablue Antibacterial Foaming Skin Cleanser
version: "9"
project_number: 566-121
epa_reg_no: null
lab: Microbac
report_date: 2023-03-15
organisms: [Staphylococcus aureus, Pseudomonas aeruginosa]
assay_types: [time_kill]
is_current: false
status: superseded
source_pdf: "M000759 Version 9 Project 566-121 PA SA SE.pdf"
---

## Table 2: Lot No. Version 9

| Organism | ATCC | Contact Time | Log Reduction | Percent Reduction |
| --- | --- | --- | --- | --- |
| Staphylococcus aureus | 6538 | 30 sec. | > 5.83 | > 99.9999 |
`;

describe('parseEfficacyFrontmatter', () => {
  it('lifts the identifying fields the ingest pipeline must not lose', () => {
    expect(parseEfficacyFrontmatter(DOCUMENT)).toEqual({
      formula_code: 'M000759',
      product_name: 'Clario Ultrablue Antibacterial Foaming Skin Cleanser',
      version: '9',
      project_number: '566-121',
      epa_reg_no: null,
      lab: 'Microbac',
      report_date: '2023-03-15',
      source_pdf: 'M000759 Version 9 Project 566-121 PA SA SE.pdf',
    });
  });

  it('does not mirror is_current or status — rag.document.is_current is the single source (B0-796)', () => {
    const parsed = parseEfficacyFrontmatter(DOCUMENT);
    expect(parsed).not.toHaveProperty('is_current');
    expect(parsed).not.toHaveProperty('status');
  });

  it('keeps a quoted numeric version as the printed string, never a number', () => {
    const parsed = parseEfficacyFrontmatter('---\nformula_code: M000141\nversion: "08"\n---\n');
    expect(parsed.version).toBe('08');
  });

  it('reads a null literal as null rather than the word "null"', () => {
    expect(parseEfficacyFrontmatter('---\nepa_reg_no: null\n---\n').epa_reg_no).toBeNull();
  });

  it('returns nothing when the document has no frontmatter block', () => {
    expect(parseEfficacyFrontmatter('## Table 1\n\n| a | b |\n')).toEqual({});
  });

  it('ignores body content that looks like frontmatter keys', () => {
    const parsed = parseEfficacyFrontmatter(
      '---\nformula_code: M000795\n---\n\nformula_code: M000000\n',
    );
    expect(parsed.formula_code).toBe('M000795');
  });
});
