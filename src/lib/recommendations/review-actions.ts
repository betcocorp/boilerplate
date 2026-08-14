'use server';

import { getServerSession } from 'next-auth';
import { revalidatePath } from 'next/cache';

import { authOptions } from '~/lib/auth';
import { writeAuditLog } from '~/lib/audit/audit-log';
import { newCorrelationId } from '~/lib/observability/correlation-id';
import { promoteRecommendationToOverride } from '~/lib/recommendations/promote-recommendation';
import { searchBetcoProducts, type BetcoProductOption } from '~/lib/recommendations/product-picker';
import {
  createRecommendationCandidate,
  getRecommendation,
  updateRecommendationCandidate,
  updateRecommendationStatus,
} from '~/lib/recommendations/repository';
import type {
  AddRecommendationCandidateInput,
  RecommendationCandidate,
  UpdateRecommendationCandidateInput,
} from '~/lib/recommendations/recommendation-schemas';

/**
 * B0-95/B0-96 — reviewer actions for the cross-reference recommendation queue
 * (`/admin/tools/cross-reference/recommendations`). Every action writes an audit-log entry
 * (`public.audit_logs` via `writeAuditLog`, the existing pattern — no new audit table). Approving
 * (`verifyRecommendation`) additionally promotes the chosen candidate into
 * `public.cross_reference_override`, the fast-path surface `lookupCrossReference()` already
 * consults first, so the very next identical lookup skips web search entirely.
 */

const REVIEW_QUEUE_PATH = '/admin/tools/cross-reference/recommendations';

async function currentReviewer(): Promise<string> {
  const session = await getServerSession(authOptions);
  return session?.user?.email ?? 'admin';
}

/**
 * B0-433 — the outcome the reviewer actually needs to see. Approving marks the recommendation
 * `verified` and *attempts* promotion; those can disagree (a candidate missing a Betco product key
 * cannot be promoted). Previously this returned void and the UI always claimed success, so a failed
 * promotion was visible only in the audit log.
 */
export type VerifyRecommendationResult =
  | { promoted: true; overrideId: string; mode: 'inserted' | 'updated' }
  | { promoted: false; reason: string };

export async function verifyRecommendation(
  recommendationId: string,
  input: { note?: string | null; chosenCandidateId?: string | null } = {},
): Promise<VerifyRecommendationResult> {
  const verifier = await currentReviewer();
  const traceId = newCorrelationId();

  await updateRecommendationStatus(recommendationId, {
    status: 'verified',
    verifier,
    note: input.note ?? null,
  });
  await writeAuditLog(
    'cross_reference_recommendation_verified',
    { recommendation_id: recommendationId, verifier, note: input.note ?? null },
    { traceId },
  );

  const withCandidates = await getRecommendation(recommendationId);
  if (!withCandidates) {
    revalidatePath(REVIEW_QUEUE_PATH);
    return { promoted: false, reason: 'Recommendation could not be reloaded after verification.' };
  }

  const promotion = await promoteRecommendationToOverride(
    withCandidates,
    input.chosenCandidateId ?? null,
    verifier,
  );
  await writeAuditLog(
    'cross_reference_recommendation_promoted',
    {
      recommendation_id: recommendationId,
      verifier,
      promoted: promotion.promoted,
      override_id: promotion.promoted ? promotion.overrideId : null,
      mode: promotion.promoted ? promotion.mode : null,
      reason: promotion.promoted ? null : promotion.reason,
    },
    { traceId },
  );

  revalidatePath(REVIEW_QUEUE_PATH);

  return promotion.promoted
    ? { promoted: true, overrideId: promotion.overrideId, mode: promotion.mode }
    : { promoted: false, reason: promotion.reason };
}

export async function rejectRecommendation(
  recommendationId: string,
  input: { reason: string },
): Promise<void> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw new Error('A rejection reason is required.');
  }

  const verifier = await currentReviewer();
  const traceId = newCorrelationId();

  await updateRecommendationStatus(recommendationId, {
    status: 'rejected',
    verifier,
    note: reason,
  });
  await writeAuditLog(
    'cross_reference_recommendation_rejected',
    { recommendation_id: recommendationId, verifier, reason },
    { traceId },
  );

  revalidatePath(REVIEW_QUEUE_PATH);
}

/**
 * B0-433 — add a candidate the engine never produced, so a recommendation with no usable candidate
 * can still be reviewed and approved rather than only rejected.
 */
export async function addRecommendationCandidate(
  recommendationId: string,
  input: AddRecommendationCandidateInput,
): Promise<RecommendationCandidate> {
  const verifier = await currentReviewer();
  const traceId = newCorrelationId();

  const candidate = await createRecommendationCandidate(recommendationId, input, verifier);
  await writeAuditLog(
    'cross_reference_recommendation_candidate_added',
    {
      recommendation_id: recommendationId,
      candidate_id: candidate.id,
      verifier,
      betco_product_key: candidate.betcoProductKey,
      betco_title: candidate.betcoTitle,
    },
    { traceId },
  );

  revalidatePath(REVIEW_QUEUE_PATH);
  return candidate;
}

/**
 * B0-441 — server-backed typeahead for the "Add a candidate" / "Edit chosen candidate" product
 * picker. No audit entry here (a search isn't a state change); the resulting selection is audited
 * when it's actually saved via `addRecommendationCandidate` / `editRecommendationCandidate`.
 */
export async function searchBetcoProductOptions(query: string): Promise<BetcoProductOption[]> {
  return searchBetcoProducts(query);
}

export async function editRecommendationCandidate(
  candidateId: string,
  patch: UpdateRecommendationCandidateInput,
): Promise<void> {
  const verifier = await currentReviewer();
  const traceId = newCorrelationId();

  await updateRecommendationCandidate(candidateId, patch);
  await writeAuditLog(
    'cross_reference_recommendation_candidate_edited',
    { candidate_id: candidateId, verifier, patch },
    { traceId },
  );

  revalidatePath(REVIEW_QUEUE_PATH);
}
