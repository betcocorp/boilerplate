'use server';

import { getServerSession } from 'next-auth';
import { revalidatePath } from 'next/cache';

import { authOptions } from '~/lib/auth';
import { writeAuditLog } from '~/lib/audit/audit-log';
import { newCorrelationId } from '~/lib/observability/correlation-id';
import { evaluateAliasFormulationVariantMerge } from '~/lib/rag/formulation-variant-rules';
import type { FormulationVariantDecision } from '~/lib/rag/formulation-variant-schemas';
import {
  approveProductAlias as approveProductAliasRow,
  editProductAlias as editProductAliasRow,
  rejectProductAlias as rejectProductAliasRow,
  searchProductLines,
} from '~/lib/rag/product-alias-review-repository';
import type { EditProductAliasInput } from '~/lib/rag/product-alias-review-schemas';

/**
 * B0-487 — reviewer actions for the alias review queue (`/admin/tools/cross-reference/aliases`).
 * Every action writes an audit-log entry (`public.audit_logs` via `writeAuditLog`, same convention
 * as `~/lib/recommendations/review-actions.ts`) and calls `revalidatePath` on this route so the
 * approve/edit/reject is reflected on next render — `rag.product_alias` has no caching layer of its
 * own (see `resolveProductLineKeyByName` in `~/lib/rag/entity-context.ts`), so the write is already
 * live for that resolver; this only refreshes the admin page itself.
 */

const ALIAS_REVIEW_QUEUE_PATH = '/admin/tools/cross-reference/aliases';

/** Throws if there's no NextAuth session — every mutation below requires an authenticated reviewer. */
async function requireReviewer(): Promise<string> {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    throw new Error('Unauthorized');
  }
  return session.user.email ?? session.user.name ?? 'admin';
}

/**
 * B0-486 — enforce `src/docs/formulation-variant-aliasing-rules.md` before an approval lands.
 *
 * Runs only when the alias's `alias_norm` maps to more than one `product_line_key` (approving a
 * single-line alias merges nothing). On `must_not_merge` / `insufficient_data` the approval is
 * abandoned before any write and the block is audited with the exact regulated values that drove
 * it. `may_merge` only clears the guard — the reviewer's own click is still what approves the row;
 * nothing here auto-approves.
 */
/** The guard's decision plus the alias text it was evaluated for, as returned by the rules module. */
type AliasFormulationDecision = FormulationVariantDecision & { alias: string };

async function guardFormulationVariantMerge(
  aliasId: string,
  reviewer: string,
  traceId: string,
): Promise<{ cleared: boolean; decision: AliasFormulationDecision }> {
  const decision = await evaluateAliasFormulationVariantMerge(aliasId);
  if (decision.productLineKeys.length < 2 || decision.verdict === 'may_merge') {
    return { cleared: true, decision };
  }

  await writeAuditLog(
    'product_alias_approval_blocked',
    {
      alias_id: aliasId,
      alias: decision.alias,
      alias_norm: decision.aliasNorm,
      reviewed_by: reviewer,
      verdict: decision.verdict,
      reason: decision.reason,
      product_line_keys: decision.productLineKeys,
      disagreements: decision.disagreements,
      data_gaps: decision.dataGaps,
      facts: decision.facts,
    },
    { traceId },
  );
  revalidatePath(ALIAS_REVIEW_QUEUE_PATH);

  return { cleared: false, decision };
}

/**
 * A blocked approval is an expected review outcome, not an exception, so it comes back as a value:
 * Next.js redacts thrown Server Action messages in production builds (the client only receives a
 * digest), which would have reduced the guard's field-by-field explanation to a generic toast for
 * the one audience that needs it. Genuine faults (no session, DB failure) still throw.
 */
export type ApproveProductAliasResult =
  | { ok: true }
  | { ok: false; blockedBy: 'formulation_variant_guard'; decision: AliasFormulationDecision };

export async function approveProductAlias(aliasId: string): Promise<ApproveProductAliasResult> {
  const reviewer = await requireReviewer();
  const traceId = newCorrelationId();

  const guard = await guardFormulationVariantMerge(aliasId, reviewer, traceId);
  if (!guard.cleared) {
    return { ok: false, blockedBy: 'formulation_variant_guard', decision: guard.decision };
  }

  const updated = await approveProductAliasRow(aliasId, reviewer);
  await writeAuditLog(
    'product_alias_approved',
    {
      alias_id: aliasId,
      reviewed_by: updated.reviewedBy,
      reviewed_at: updated.reviewedAt,
      // B0-486 — record which formulation-variant branch cleared this approval.
      formulation_variant_verdict: guard.decision.verdict,
      formulation_variant_product_line_keys: guard.decision.productLineKeys,
    },
    { traceId },
  );

  revalidatePath(ALIAS_REVIEW_QUEUE_PATH);
  return { ok: true };
}

export async function editProductAlias(
  aliasId: string,
  patch: EditProductAliasInput,
): Promise<void> {
  const reviewer = await requireReviewer();
  const traceId = newCorrelationId();

  const updated = await editProductAliasRow(aliasId, patch);
  await writeAuditLog(
    'product_alias_edited',
    {
      alias_id: aliasId,
      reviewed_by: reviewer,
      product_line_key: updated.productLineKey,
      alias_type: updated.aliasType,
    },
    { traceId },
  );

  revalidatePath(ALIAS_REVIEW_QUEUE_PATH);
}

export async function rejectProductAlias(aliasId: string): Promise<void> {
  const reviewer = await requireReviewer();
  const traceId = newCorrelationId();

  await rejectProductAliasRow(aliasId);
  await writeAuditLog('product_alias_rejected', { alias_id: aliasId, reviewed_by: reviewer }, { traceId });

  revalidatePath(ALIAS_REVIEW_QUEUE_PATH);
}

/** Server-backed typeahead for the edit form's product-line picker (no audit entry — a search isn't a write). */
export async function searchProductLineOptions(
  query: string,
): Promise<Array<{ productLineKey: string; title: string }>> {
  return searchProductLines(query);
}
