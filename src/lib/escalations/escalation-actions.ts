'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  ESCALATION_STATUSES,
  updateEscalationStatus,
} from '~/lib/escalations/escalation-repository';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePermission } from '~/lib/permissions/require-permission';

const ESCALATIONS_ROUTE = '/admin/escalations';

// Module-private: a 'use server' file may only export async functions.
const updateEscalationStatusInputSchema = z.object({
  id: z.uuid(),
  status: z.enum(ESCALATION_STATUSES),
  resolutionNotes: z.string().trim().max(4000).optional().default(''),
});

export type UpdateEscalationStatusActionInput = z.input<typeof updateEscalationStatusInputSchema>;

/**
 * B0-528 — status change for one escalation from /admin/escalations. Gated with the same
 * permission as the page (the sidebar Observability selector), validated with Zod at the boundary,
 * and revalidates the list so the server-rendered table reflects the new status on refresh.
 */
export async function updateEscalationStatusAction(
  raw: UpdateEscalationStatusActionInput,
): Promise<{ ok: true; reference: string; status: string } | { ok: false; error: string }> {
  const permission = await requirePermission(PERMISSIONS.NAVIGATION_SIDEBAR_OBSERVABILITY, {
    route: `POST ${ESCALATIONS_ROUTE}`,
  });
  if (!permission.allowed) {
    return { ok: false, error: 'Forbidden' };
  }

  const parsed = updateEscalationStatusInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }

  try {
    const row = await updateEscalationStatus({
      id: parsed.data.id,
      status: parsed.data.status,
      resolutionNotes: parsed.data.resolutionNotes ? parsed.data.resolutionNotes : null,
    });
    revalidatePath(ESCALATIONS_ROUTE);
    return { ok: true, reference: row.reference, status: row.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Update failed' };
  }
}
