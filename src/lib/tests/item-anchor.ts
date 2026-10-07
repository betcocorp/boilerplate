/**
 * B0-1145 — the `#item-<testItemId>` fragment that deep-links a `/admin/tests/[testId]` page to
 * one prompt row. Shared by the prompt search dialog (link builder) and `TestPromptsSection`
 * (row ids + landing scroll) so the two sides can't drift.
 */
export const ITEM_ANCHOR_PREFIX = '#item-';

export function itemAnchorId(testItemId: string): string {
  return `item-${testItemId}`;
}

export function testItemHref(testId: string, testItemId: string): string {
  return `/admin/tests/${testId}${ITEM_ANCHOR_PREFIX}${testItemId}`;
}
