'use server';

import { getServerSession } from 'next-auth';
import { revalidatePath } from 'next/cache';

import { authOptions } from '~/lib/auth';
import { writeAuditLog } from '~/lib/audit/audit-log';
import { newCorrelationId } from '~/lib/observability/correlation-id';
import { promoteRecommendationToOverride } from '~/lib/recommendations/promote-recommendation';
import {
  getRecommendation,
  updateRecommendationCandidate,
  updateRecommendationStatus,
} from '~/lib/recommendations/repository';
import type { UpdateRecommendationCandidateInput } from '~/lib/recommendations/recommendation-schemas';

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

export async function verifyRecommendation(
  recommendationId: string,
  input: { note?: string | null; chosenCandidateId?: string | null } = {},
): Promise<void> {
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
  if (withCandidates) {
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
  }

  revalidatePath(REVIEW_QUEUE_PATH);
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
