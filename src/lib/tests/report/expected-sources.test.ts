import { describe, expect, it } from 'vitest';

import {
  collectExpectedSourceIds,
  formatExpectedSourceRef,
  formatExpectedSourceRefs,
  resolveExpectedSourceRefs,
  UNRESOLVED_EXPECTED_SOURCE_LABEL,
  type ExpectedSourceIndex,
} from './expected-sources';

/**
 * B0-933 — `test_items.expected_sources` is a `uuid[]` of `rag.document.id`. These pin the two
 * things a report reader depends on: a uuid is never shown on its own when the document resolves,
 * and a uuid that no longer resolves is never silently dropped.
 */

const LIVE = '11111111-1111-4111-8111-111111111111';
const LIVE_NO_KIND = '22222222-2222-4222-8222-222222222222';
const LIVE_NO_TITLE = '33333333-3333-4333-8333-333333333333';
const PURGED = '44444444-4444-4444-8444-444444444444';

/** A title carrying an EPA registration number — it must survive byte-for-byte. */
const LABEL_TITLE = 'pH7Q Dual product label — EPA Reg. No. 6836-140-4170';

const INDEX: ExpectedSourceIndex = new Map([
  [LIVE, { title: LABEL_TITLE, documentKind: 'label' }],
  [LIVE_NO_KIND, { title: 'Selector Guide Section 1', documentKind: null }],
  [LIVE_NO_TITLE, { title: null, documentKind: 'sds' }],
]);

describe('resolveExpectedSourceRefs', () => {
  it('resolves in the order the item stores them and marks what it cannot resolve', () => {
    expect(resolveExpectedSourceRefs([LIVE, PURGED, LIVE_NO_KIND], INDEX)).toEqual([
      { id: LIVE, title: LABEL_TITLE, documentKind: 'label', resolved: true },
      { id: PURGED, title: null, documentKind: null, resolved: false },
      { id: LIVE_NO_KIND, title: 'Selector Guide Section 1', documentKind: null, resolved: true },
    ]);
  });

  it('never drops an id when the index is missing entirely', () => {
    const refs = resolveExpectedSourceRefs([LIVE, PURGED], null);
    expect(refs.map((r) => r.id)).toEqual([LIVE, PURGED]);
    expect(refs.every((r) => !r.resolved)).toBe(true);
  });

  it('returns nothing for an empty or absent column', () => {
    expect(resolveExpectedSourceRefs([], INDEX)).toEqual([]);
    expect(resolveExpectedSourceRefs(null, INDEX)).toEqual([]);
    expect(resolveExpectedSourceRefs(undefined, INDEX)).toEqual([]);
  });
});

describe('formatExpectedSourceRef', () => {
  it('shows the title verbatim with its kind, never the uuid, when the document resolves', () => {
    const [ref] = resolveExpectedSourceRefs([LIVE], INDEX);
    expect(formatExpectedSourceRef(ref!)).toBe(`${LABEL_TITLE} (label)`);
    // Regulated-data rule: the EPA number is not re-cased, spaced or reformatted.
    expect(formatExpectedSourceRef(ref!)).toContain('EPA Reg. No. 6836-140-4170');
  });

  it('omits the parenthesised kind when the document has none', () => {
    const [ref] = resolveExpectedSourceRefs([LIVE_NO_KIND], INDEX);
    expect(formatExpectedSourceRef(ref!)).toBe('Selector Guide Section 1');
  });

  it('falls back to the uuid for a resolved row with no title', () => {
    const [ref] = resolveExpectedSourceRefs([LIVE_NO_TITLE], INDEX);
    expect(formatExpectedSourceRef(ref!)).toBe(`${LIVE_NO_TITLE} (sds)`);
  });

  it('marks an unresolved uuid rather than hiding it', () => {
    const [ref] = resolveExpectedSourceRefs([PURGED], INDEX);
    expect(formatExpectedSourceRef(ref!)).toBe(`${PURGED} — ${UNRESOLVED_EXPECTED_SOURCE_LABEL}`);
  });

  it('joins a case’s sources on a single line', () => {
    expect(formatExpectedSourceRefs(resolveExpectedSourceRefs([LIVE, PURGED], INDEX))).toBe(
      `${LABEL_TITLE} (label); ${PURGED} — ${UNRESOLVED_EXPECTED_SOURCE_LABEL}`,
    );
    expect(formatExpectedSourceRefs([])).toBe('');
  });
});

describe('collectExpectedSourceIds', () => {
  it('de-duplicates across items so the lookup is one batched read, in first-seen order', () => {
    expect(
      collectExpectedSourceIds([
        { expected_sources: [LIVE, PURGED] },
        { expected_sources: [PURGED, LIVE_NO_KIND] },
        { expected_sources: [] },
        { expected_sources: null },
        {},
      ]),
    ).toEqual([LIVE, PURGED, LIVE_NO_KIND]);
  });

  it('drops blank entries without dropping the rest', () => {
    expect(collectExpectedSourceIds([{ expected_sources: ['', '  ', LIVE] }])).toEqual([LIVE]);
  });
});
