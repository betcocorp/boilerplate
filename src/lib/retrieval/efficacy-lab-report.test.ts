import { describe, expect, it } from 'vitest';

import {
  extractProductQualifier,
  isCalculatedDataTableForQualifier,
  pickMostCurrentDocument,
  renderEfficacyLabReportCitation,
  type EfficacyDocumentRow,
} from '~/lib/retrieval/efficacy-lab-report';

/**
 * B0-802 — table disambiguation: a shared lab report (one document, several
 * formulas) carries multiple "TABLE n: CALCULATED DATA FOR <formula>" blocks for
 * the SAME organism. buildCitation() must prefer the block belonging to the
 * document's own formula/product, never just the first organism match.
 *
 * B0-796 — deterministic tie-break: fetchCurrentEfficacyLabReport() must not rely
 * on RPC row order (docs[0]) when more than one is_current=true document remains
 * for a product line.
 */

describe('extractProductQualifier (B0-802)', () => {
  it('reduces an M0-prefixed formula code to its bare product code', () => {
    expect(extractProductQualifier('M000796')).toBe('796');
    expect(extractProductQualifier('m000795')).toBe('795');
  });

  it('returns a bare (non-M0-prefixed) formula code upper-cased, unchanged', () => {
    // Legacy/disinfectant corpora: the formula code already IS the product code.
    expect(extractProductQualifier('af79')).toBe('AF79');
  });

  it('returns null for a missing formula code', () => {
    expect(extractProductQualifier(null)).toBeNull();
  });
});

describe('isCalculatedDataTableForQualifier (B0-802)', () => {
  // Real corpus shape (M000796 Version 6, Project A32791): one shared lab report
  // carries CALCULATED DATA tables for 795, 796, AND 797 — same organisms in each.
  const table795 =
    'Product/Formula: M000796 Version 6 ( 5% eth) Project A32791 PA SA SE\n' +
    'TABLE 7: CALCULATED DATA FOR 795 5% less by volume ETOH\n' +
    '| Organism | ATCC | Contact Time | Log Reduction | Percent Reduction |\n' +
    '| Pseudomonas aeruginosa | 15442 | 15 seconds | >5.65 | >99.999% |';
  const table796 =
    'Product/Formula: M000796 Version 6 ( 5% eth) Project A32791 PA SA SE\n' +
    'TABLE 8: CALCULATED DATA FOR 796 5% less by volume ETOH\n' +
    '| Organism | ATCC | Contact Time | Log Reduction | Percent Reduction |\n' +
    '| Pseudomonas aeruginosa | 15442 | 15 seconds | >5.65 | >99.999% |';
  const table797 =
    'Product/Formula: M000796 Version 6 ( 5% eth) Project A32791 PA SA SE\n' +
    'TABLE 9: CALCULATED DATA FOR 797 5% less by volume ETOH\n' +
    '| Organism | ATCC | Contact Time | Log Reduction | Percent Reduction |\n' +
    '| Pseudomonas aeruginosa | 15442 | 15 seconds | >5.65 | >99.999% |';

  it('matches only the table whose heading names this qualifier', () => {
    expect(isCalculatedDataTableForQualifier(table796, '796')).toBe(true);
    expect(isCalculatedDataTableForQualifier(table795, '796')).toBe(false);
    expect(isCalculatedDataTableForQualifier(table797, '796')).toBe(false);
  });

  it('does not false-positive match a qualifier that is a substring of another number', () => {
    // "79" must not match inside "796" / "795" / "797".
    expect(isCalculatedDataTableForQualifier(table796, '79')).toBe(false);
  });

  it('is false for a chunk with no CALCULATED DATA heading (e.g. a CONTROL RESULTS table)', () => {
    const controlResults =
      'TABLE 1: CONTROL RESULTS\n| Type of Control | Results |\n| Purity Control | Pure |';
    expect(isCalculatedDataTableForQualifier(controlResults, '796')).toBe(false);
  });

  it('returns false when no qualifier is available', () => {
    expect(isCalculatedDataTableForQualifier(table796, null)).toBe(false);
  });
});

function makeDoc(overrides: Partial<EfficacyDocumentRow>): EfficacyDocumentRow {
  return {
    id: 'doc-default',
    title: 'Default',
    source_record_id: 'sr-1',
    is_current: true,
    cites_data_from_document_id: null,
    metadata: null,
    source_lab: null,
    project_number: null,
    summary: null,
    body_text: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('pickMostCurrentDocument (B0-796 AC2)', () => {
  it('picks the most recently created document, not array order', () => {
    const older = makeDoc({ id: 'a', created_at: '2026-01-01T00:00:00Z' });
    const newer = makeDoc({ id: 'b', created_at: '2026-06-01T00:00:00Z' });
    // docs[0] would previously have picked `older` — the fix must not.
    expect(pickMostCurrentDocument([older, newer]).id).toBe('b');
    expect(pickMostCurrentDocument([newer, older]).id).toBe('b');
  });

  it('falls back to id for a fully deterministic order on an exact created_at tie', () => {
    const docA = makeDoc({ id: 'zzz', created_at: '2026-01-01T00:00:00Z' });
    const docB = makeDoc({ id: 'aaa', created_at: '2026-01-01T00:00:00Z' });
    expect(pickMostCurrentDocument([docA, docB]).id).toBe('aaa');
    expect(pickMostCurrentDocument([docB, docA]).id).toBe('aaa');
  });

  it('is a no-op for a single document', () => {
    const only = makeDoc({ id: 'solo' });
    expect(pickMostCurrentDocument([only]).id).toBe('solo');
  });
});

describe('renderEfficacyLabReportCitation NR guardrail (B0-802)', () => {
  it('always includes the "No Reduction" / NR non-affirmative-claim guardrail', () => {
    const rendered = renderEfficacyLabReportCitation({
      documentId: 'doc-1',
      formulaCode: 'M000796',
      version: '6',
      lab: 'Analytical Lab Group',
      projectNumber: 'A32791',
      isCurrent: true,
      citesDataFromDocumentId: null,
      sourceUri: 's3://bucket/key.pdf',
      title: 'M000796 Version 6',
      excerpt: '| Organism | Log Reduction |\n| Pseudomonas aeruginosa | No Reduction |',
    });

    expect(rendered).toContain('No Reduction');
    expect(rendered).toContain('never invert it into a positive/affirmative');
    // The guardrail must travel WITH the excerpt, not just exist somewhere unrelated.
    expect(rendered.indexOf('Reading this table')).toBeLessThan(rendered.indexOf(
      'Pseudomonas aeruginosa | No Reduction',
    ));
  });
});
