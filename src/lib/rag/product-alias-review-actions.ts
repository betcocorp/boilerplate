'use server';

import { getServerSession } from 'next-auth';
import { revalidatePath } from 'next/cache';

import { authOptions } from '~/lib/auth';
import { writeAuditLog } from '~/lib/audit/audit-log';
import { newCorrelationId } from '~/lib/observability/correlation-id';
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

export async function approveProductAlias(aliasId: string): Promise<void> {
  const reviewer = await requireReviewer();
  const traceId = newCorrelationId();

  const updated = await approveProductAliasRow(aliasId, reviewer);
  await writeAuditLog(
    'product_alias_approved',
    { alias_id: aliasId, reviewed_by: updated.reviewedBy, reviewed_at: updated.reviewedAt },
    { traceId },
  );

  revalidatePath(ALIAS_REVIEW_QUEUE_PATH);
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
