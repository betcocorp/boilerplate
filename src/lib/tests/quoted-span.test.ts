import { describe, expect, it } from 'vitest';

import {
  extractQuotedSpans,
  normalizeForComparison,
  scoreQuotedSpans,
  summarizeQuotedSpans,
} from '~/lib/tests/quoted-span';
import type { ResolvedContext } from '~/lib/tests/retrieval-dataset';

const CHUNK_A = '11111111-2222-3333-4444-555555555555';

function ctx(overrides: Partial<ResolvedContext> = {}): ResolvedContext {
  return {
    document_id: 'doc-1',
    chunk_id: CHUNK_A,
    document_title: null,
    document_kind: 'label',
    product_line_key: null,
    text: null,
    heading: null,
    chunk_index: 0,
    resolution: 'resolved',
    ...overrides,
  };
}

describe('normalizeForComparison', () => {
  it('folds case, whitespace, curly quotes and unicode dashes', () => {
    expect(normalizeForComparison('  The  Surface\nMust   Remain  ')).toBe('the surface must remain');
    expect(normalizeForComparison('“zero installation”')).toBe('"zero installation"');
    expect(normalizeForComparison('2–3 hours')).toBe('2-3 hours');
    // Measured false positive: the model writes "&" where the corpus stores "and".
    expect(normalizeForComparison('Restoration & Repair')).toBe('restoration and repair');
  });

  it('preserves every character that carries regulated meaning', () => {
    // The whole point of the metric is catching a wrong ratio or registration number. Any
    // normalization that collapsed these would make 1:64 and 1:6 compare equal.
    expect(normalizeForComparison('Dilute 1:64')).toBe('dilute 1:64');
    expect(normalizeForComparison('EPA Reg. No. 6836-78')).toBe('epa reg. no. 6836-78');
    expect(normalizeForComparison('200 ppm')).toBe('200 ppm');
    expect(normalizeForComparison('10 minutes')).toBe('10 minutes');
  });
});

describe('extractQuotedSpans', () => {
  it('returns nothing when the answer quotes nothing', () => {
    expect(extractQuotedSpans('Dilute at 1:64 for daily cleaning.')).toEqual([]);
  });

  it('ignores spans below the word floor', () => {
    expect(extractQuotedSpans('The label says "wet contact" here.')).toEqual([]);
    expect(extractQuotedSpans('The label says "wet contact" here.', { minWords: 2 })).toHaveLength(1);
  });

  it('extracts curly-quoted spans', () => {
    const spans = extractQuotedSpans('Described as “zero installation or maintenance required” today.');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.span).toBe('zero installation or maintenance required');
  });

  it('strips inch marks so tile dimensions do not invert quote pairing', () => {
    // Measured in the corpus: `9" x 9"` produced debris spans (`x 9`, 16 occurrences) and shifted
    // the open/close parity for every later quotation in the same answer.
    const answer =
      'Tiles of 9" x 9" are likely VAT. The guide states "assume asbestos until proven otherwise here".';
    const spans = extractQuotedSpans(answer);

    expect(spans).toHaveLength(1);
    expect(spans[0]!.span).toBe('assume asbestos until proven otherwise here');
    expect(spans[0]!.unbalancedQuotes).toBe(false);
  });

  it('does not treat a mid-sentence opening as suspicious', () => {
    // Measured: punctuation-, lowercase- and uppercase-leading spans all match sources at ~79-86%.
    // Opening shape carries no drift signal, so a fragment quote stays fully scorable.
    const spans = extractQuotedSpans('text "line) to the unit. This involves moderate plumbing work" more');
    expect(spans[0]!.unbalancedQuotes).toBe(false);
  });

  it('flags every span when quote characters are unbalanced', () => {
    const spans = extractQuotedSpans('An "unclosed quotation sits here and "then another one appears" too');
    expect(spans.every((s) => s.unbalancedQuotes)).toBe(true);
  });
});

describe('scoreQuotedSpans', () => {
  const labelChunk = ctx({
    text: 'The surface must remain visibly wet for at least 60 seconds. Dilute at 1:64.',
    document_title: 'GE Fight Bac RTU',
  });

  it('returns null rather than 0 when the answer quotes nothing', () => {
    const result = scoreQuotedSpans('Dilute at 1:64 for daily use.', [labelChunk]);

    // Nothing to check is not everything failed — a 0 here would punish the plainest answers.
    expect(result.score).toBeNull();
    expect(result.contentScore).toBeNull();
    expect(result.scorable).toBe(0);
  });

  it('matches a verbatim content quotation and reports its provenance', () => {
    const result = scoreQuotedSpans(
      'The label states "the surface must remain visibly wet for at least 60 seconds".',
      [labelChunk],
    );

    expect(result.score).toBe(1);
    expect(result.contentScore).toBe(1);
    expect(result.spans[0]!.kind).toBe('content');
    expect(result.spans[0]!.matchedIn).toBe('chunk_text');
    expect(result.spans[0]!.matchedChunkId).toBe(CHUNK_A);
  });

  it('matches across whitespace and case differences', () => {
    const result = scoreQuotedSpans(
      'Per the label: "The Surface   Must\nRemain Visibly Wet for at least 60 seconds".',
      [labelChunk],
    );

    expect(result.score).toBe(1);
  });

  it('does not match a regulated value that differs', () => {
    // 1:64 vs 1:128 — the failure mode the metric exists for. Must not be normalized together.
    const result = scoreQuotedSpans('The label says "dilute at 1:128 for daily cleaning".', [labelChunk]);

    expect(result.spans[0]!.kind).toBe('unmatched');
    expect(result.score).toBe(0);
  });

  it('scores a fabricated span as unmatched', () => {
    const result = scoreQuotedSpans(
      'The label states "kills norovirus in under five seconds flat" which is untrue.',
      [labelChunk],
    );

    expect(result.score).toBe(0);
    expect(result.spans[0]!.kind).toBe('unmatched');
    expect(result.spans[0]!.matchedDocumentId).toBeNull();
  });

  it('counts a title citation separately from a content quotation', () => {
    // 66% of real quoted spans are document titles. Counting them as grounding evidence would
    // overstate faithfulness; counting them as fabrications would understate it.
    const titled = ctx({
      text: 'Body text that says nothing about gym floors.',
      document_title: 'Daily Care & Cleaning for Wood Gym Floors',
    });
    const result = scoreQuotedSpans('Per "Daily Care and Cleaning for Wood Gym Floors", sweep daily.', [titled]);

    expect(result.spans[0]!.kind).toBe('title');
    expect(result.spans[0]!.matchedIn).toBe('document_title');
    expect(result.titleCitations).toBe(1);
    expect(result.score).toBe(1);
    // Excluded from both sides of contentScore — it asserts provenance, not a fact.
    expect(result.contentScore).toBeNull();
  });

  it('matches a chunk heading as a title citation', () => {
    const headed = ctx({ text: 'Body.', heading: 'Surfaces & Visual Cleanliness' });
    const result = scoreQuotedSpans('See "Surfaces & Visual Cleanliness" for the list.', [headed], {
      minWords: 3,
    });

    expect(result.spans[0]!.matchedIn).toBe('heading');
  });

  it('excludes unresolved chunk text from the haystack', () => {
    const unresolved = ctx({ text: null, resolution: 'missing' });
    const result = scoreQuotedSpans(
      'The label states "the surface must remain visibly wet for at least 60 seconds".',
      [unresolved],
    );

    // Unknown text must not be reported as a fabrication, so the count is surfaced for the caller.
    expect(result.resolvedChunks).toBe(0);
    expect(result.unresolvedRefs).toBe(1);
    expect(result.spans[0]!.kind).toBe('unmatched');
  });

  it('still matches titles on unresolved refs, since titles come from the run payload', () => {
    const unresolved = ctx({
      text: null,
      resolution: 'missing',
      document_title: 'Betco Life Cycle of Floor Care Training',
    });
    const result = scoreQuotedSpans('Per "Betco Life Cycle of Floor Care Training", strip annually.', [
      unresolved,
    ]);

    expect(result.spans[0]!.kind).toBe('title');
  });

  it('scores a lowercase-opening fragment quote normally', () => {
    const result = scoreQuotedSpans(
      'The label notes that "the surface must remain visibly wet for at least 60 seconds".',
      [labelChunk],
    );

    expect(result.spans[0]!.pairingDriftSuspected).toBe(false);
    expect(result.scorable).toBe(1);
    expect(result.score).toBe(1);
  });

  it('still scores an unmatched mid-sentence span as a fabrication, not an artifact', () => {
    // Suppressing these would hide real fabrications that happen to start lowercase.
    const result = scoreQuotedSpans(
      'text "line) to the unit. This involves moderate plumbing work here" more',
      [labelChunk],
    );

    expect(result.spans[0]!.pairingDriftSuspected).toBe(false);
    expect(result.scorable).toBe(1);
    expect(result.score).toBe(0);
  });

  it('excludes drift-suspected spans from the ratio instead of failing them', () => {
    const result = scoreQuotedSpans(
      'An "unclosed quotation sits here and "then another fragment appears" too',
      [labelChunk],
    );

    expect(result.driftExcluded).toBeGreaterThan(0);
    expect(result.scorable).toBe(0);
    expect(result.score).toBeNull();
  });
});

describe('summarizeQuotedSpans', () => {
  it('excludes items with nothing to score from the mean', () => {
    const chunk = ctx({ text: 'alpha beta gamma delta epsilon zeta' });
    const quoted = scoreQuotedSpans('It says "alpha beta gamma delta epsilon".', [chunk]);
    const missed = scoreQuotedSpans('It says "nothing like the source text here".', [chunk]);
    const silent = scoreQuotedSpans('No quotations at all.', [chunk]);

    const summary = summarizeQuotedSpans([quoted, missed, silent]);

    expect(summary.itemsScored).toBe(2);
    expect(summary.itemsWithoutSpans).toBe(1);
    expect(summary.meanScore).toBe(0.5);
    expect(summary.totalUnmatched).toBe(1);
  });
});
