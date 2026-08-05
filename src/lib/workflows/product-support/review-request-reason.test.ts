import { describe, expect, it } from 'vitest';

import {
  REVIEW_REQUEST_REASONS,
  resolveReviewRequestReason,
} from '~/lib/workflows/product-support/run-product-support-workflow';

/**
 * B0-368 — every new `review_requested` audit row (and the matching `review_tasks`
 * row) must carry a non-null discriminator from one closed set, so a reviewer can
 * triage without reading the raw `issues` array.
 */
describe('resolveReviewRequestReason', () => {
  it('prefers the regulated-claim guardrail over everything else', () => {
    expect(
      resolveReviewRequestReason({
        hasUngroundedRegulatedClaim: true,
        revisionPassRefused: true,
      }),
    ).toBe('regulated_claim_unverified');
  });

  it('distinguishes the revision-refusal path from a plain validator rejection', () => {
    expect(
      resolveReviewRequestReason({
        hasUngroundedRegulatedClaim: false,
        revisionPassRefused: true,
      }),
    ).toBe('revision_refused');
  });

  it('falls back to validator_rejected', () => {
    expect(
      resolveReviewRequestReason({
        hasUngroundedRegulatedClaim: false,
        revisionPassRefused: false,
      }),
    ).toBe('validator_rejected');
  });

  it('never returns anything outside the closed set', () => {
    for (const hasUngroundedRegulatedClaim of [true, false]) {
      for (const revisionPassRefused of [true, false]) {
        expect(REVIEW_REQUEST_REASONS).toContain(
          resolveReviewRequestReason({ hasUngroundedRegulatedClaim, revisionPassRefused }),
        );
      }
    }
  });

  it('keeps the vocabulary the review_tasks table already uses', () => {
    // 208 existing rows say `regulated_claim_unverified`, 12 say `validator_rejected`;
    // renaming them would split every existing triage query.
    expect(REVIEW_REQUEST_REASONS).toContain('regulated_claim_unverified');
    expect(REVIEW_REQUEST_REASONS).toContain('validator_rejected');
  });
});
