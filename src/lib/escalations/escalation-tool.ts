/**
 * B0-528 — executor for the `escalation_specialist` product tool.
 *
 * Lives here (not inline in `~/lib/tools/product-tools.ts`, which only delegates) so it can be unit
 * tested against a mocked service-role client without that module's retrieval mock surface.
 *
 * Contract with the model (also stated in the tool description, `~/lib/tools/definitions.ts`):
 * the returned `message` is the exact acknowledgment sentence to relay. Three outcomes, all
 * `ok: true` so the generation loop never treats a deliberate non-insert as a tool failure:
 *   - `status: 'open'`     — a new row was written; `reference` is the id to quote.
 *   - `status: 'disabled'` — `BEX_ESCALATION_TOOL_ENABLED` is off; nothing was written, no reference.
 *   - `duplicate: true`    — this workflow run already logged an escalation; its reference is
 *                            returned again instead of a second row ("at most once per turn").
 */

import {
  findEscalationByWorkflowRunId,
  getConversationOwnership,
  insertEscalation,
  ESCALATION_SOURCES,
  type EscalationRow,
  type EscalationSource,
} from '~/lib/escalations/escalation-repository';
import { isEscalationToolEnabled } from '~/lib/settings/settings-service';
import { escalationSpecialistInputSchema } from '~/lib/tools/tool-schemas';

import type { AuditContext } from '~/lib/audit/audit-log';

export const ESCALATION_TOOL_ADAPTER = 'escalation_record_v1' as const;

export const ESCALATION_DISABLED_MESSAGE =
  "I don't have a verified answer for that, and escalation logging is currently turned off, so I could not open a follow-up for the Betco team. Please contact Betco customer support directly.";

/** The sentence the model relays, verbatim, once a record exists. */
export function buildEscalationAcknowledgment(reference: string): string {
  return `I don't have a verified answer for that. I've logged escalation ${reference} for the Betco team to follow up.`;
}

export type EscalationToolResult = {
  ok: true;
  adapter: typeof ESCALATION_TOOL_ADAPTER;
  status: EscalationRow['status'] | 'disabled';
  escalationId: string | null;
  reference: string | null;
  message: string;
  /** Set when an existing record for this run was returned instead of inserting a second one. */
  duplicate?: true;
};

function coerceSource(raw: string | null | undefined): EscalationSource | null {
  return raw && (ESCALATION_SOURCES as readonly string[]).includes(raw)
    ? (raw as EscalationSource)
    : null;
}

function toResult(row: EscalationRow, duplicate: boolean): EscalationToolResult {
  return {
    ok: true,
    adapter: ESCALATION_TOOL_ADAPTER,
    status: row.status,
    escalationId: row.id,
    reference: row.reference,
    message: buildEscalationAcknowledgment(row.reference),
    ...(duplicate ? { duplicate: true as const } : {}),
  };
}

export async function runEscalationSpecialistTool(
  args: unknown,
  auditCtx?: AuditContext,
): Promise<EscalationToolResult> {
  // Parse first, like every other tool: a malformed call is a thrown Zod error → `ok: false`.
  const input = escalationSpecialistInputSchema.parse(args);

  if (!(await isEscalationToolEnabled())) {
    return {
      ok: true,
      adapter: ESCALATION_TOOL_ADAPTER,
      status: 'disabled',
      escalationId: null,
      reference: null,
      message: ESCALATION_DISABLED_MESSAGE,
    };
  }

  const workflowRunId = auditCtx?.workflowRunId ?? null;
  if (workflowRunId) {
    const existing = await findEscalationByWorkflowRunId(workflowRunId);
    if (existing) {
      return toResult(existing, true);
    }
  }

  const conversationId = auditCtx?.conversationId ?? null;
  const ownership = conversationId
    ? await getConversationOwnership(conversationId)
    : { userId: null, actedByUserId: null };

  const row = await insertEscalation({
    reason: input.reason,
    question: input.question?.trim() || input.summary,
    summary: input.summary,
    retrievedSources: input.retrievedSources ?? [],
    // The running specialist (audit context) is authoritative over whatever the model typed.
    specialist: auditCtx?.specialistId ?? input.specialist ?? null,
    source: coerceSource(auditCtx?.runSource),
    workflowRunId,
    conversationId,
    userId: ownership.userId,
    actedByUserId: ownership.actedByUserId,
  });

  return toResult(row, false);
}
