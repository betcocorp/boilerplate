import { beforeEach, describe, expect, it, vi } from 'vitest';

const isEscalationToolEnabledMock = vi.hoisted(() => vi.fn());
const fromMock = vi.hoisted(() => vi.fn());

vi.mock('~/lib/settings/settings-service', () => ({
  isEscalationToolEnabled: () => isEscalationToolEnabledMock(),
}));

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => ({ from: fromMock }),
}));

import {
  buildEscalationAcknowledgment,
  ESCALATION_DISABLED_MESSAGE,
  ESCALATION_TOOL_ADAPTER,
  runEscalationSpecialistTool,
} from '~/lib/escalations/escalation-tool';
import { escalationSpecialistInputSchema } from '~/lib/tools/tool-schemas';

const BASE_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  created_at: '2026-10-05T19:00:00.000Z',
  updated_at: '2026-10-05T19:00:00.000Z',
  status: 'open',
  reference: 'ESC-0042',
  source: 'bex_chat',
  workflow_run_id: '22222222-2222-4222-8222-222222222222',
  conversation_id: '33333333-3333-4333-8333-333333333333',
  user_id: 'acted-as-1',
  acted_by_user_id: 'admin-true-1',
  specialist: 'bathroom',
  reason: 'regulated_value_not_on_file',
  question: 'What is the contact time for pH7Q on grout?',
  summary: 'No label on file lists a grout contact time; search_product_docs and get_efficacy_data returned nothing.',
  retrieved_sources: [{ title: 'pH7Q Label', documentId: 'doc-1' }],
  external_ticket_ref: null,
  resolved_at: null,
  resolution_notes: null,
};

type TableMocks = {
  insert: ReturnType<typeof vi.fn>;
  existing: Record<string, unknown> | null;
  conversation: { user_id: string | null; acted_by_user_id: string | null } | null;
};

/** Minimal PostgREST-builder shaped mock covering the three queries the executor can issue. */
function mockTables({ insert, existing, conversation }: TableMocks) {
  fromMock.mockImplementation((table: string) => {
    if (table === 'escalations') {
      return {
        insert: (row: Record<string, unknown>) => {
          insert(row);
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { ...BASE_ROW, ...row }, error: null }),
            }),
          };
        },
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: () => Promise.resolve({ data: existing, error: null }),
              }),
            }),
          }),
        }),
      };
    }
    if (table === 'agent_conversations') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: conversation, error: null }),
          }),
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

const VALID_ARGS = {
  reason: 'regulated_value_not_on_file',
  summary: BASE_ROW.summary,
  question: BASE_ROW.question,
  retrievedSources: [{ title: 'pH7Q Label', documentId: 'doc-1' }],
};

const CTX = {
  traceId: 'trace-1',
  conversationId: BASE_ROW.conversation_id,
  workflowRunId: BASE_ROW.workflow_run_id,
  specialistId: 'bathroom',
  runSource: 'bex_chat',
};

beforeEach(() => {
  fromMock.mockReset();
  isEscalationToolEnabledMock.mockReset();
});

describe('escalationSpecialistInputSchema (B0-528)', () => {
  it('accepts every reason in the enum with a summary', () => {
    for (const reason of [
      'no_evidence',
      'low_confidence',
      'regulated_value_not_on_file',
      'out_of_scope',
      'compatibility_unverified',
      'safety_incident',
      'user_requested',
      'other',
    ]) {
      expect(escalationSpecialistInputSchema.safeParse({ reason, summary: 's' }).success).toBe(true);
    }
  });

  it('rejects an unknown reason, a blank summary, and a malformed retrievedSources entry', () => {
    expect(escalationSpecialistInputSchema.safeParse({ reason: 'hubspot', summary: 's' }).success).toBe(
      false,
    );
    expect(
      escalationSpecialistInputSchema.safeParse({ reason: 'no_evidence', summary: '   ' }).success,
    ).toBe(false);
    expect(
      escalationSpecialistInputSchema.safeParse({
        reason: 'no_evidence',
        summary: 's',
        retrievedSources: [{ documentId: 'doc-1' }],
      }).success,
    ).toBe(false);
  });
});

describe('runEscalationSpecialistTool — enabled (B0-528)', () => {
  it('inserts the row with the run context and returns the reference + acknowledgment', async () => {
    isEscalationToolEnabledMock.mockResolvedValue(true);
    const insert = vi.fn();
    mockTables({
      insert,
      existing: null,
      conversation: { user_id: 'acted-as-1', acted_by_user_id: 'admin-true-1' },
    });

    const result = await runEscalationSpecialistTool(VALID_ARGS, CTX);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith({
      reason: 'regulated_value_not_on_file',
      question: BASE_ROW.question,
      summary: BASE_ROW.summary,
      retrieved_sources: [{ title: 'pH7Q Label', documentId: 'doc-1' }],
      // B0-780 context wins over anything the model typed; B0-1084 ownership is copied as-is.
      specialist: 'bathroom',
      source: 'bex_chat',
      workflow_run_id: BASE_ROW.workflow_run_id,
      conversation_id: BASE_ROW.conversation_id,
      user_id: 'acted-as-1',
      acted_by_user_id: 'admin-true-1',
    });
    expect(result).toEqual({
      ok: true,
      adapter: ESCALATION_TOOL_ADAPTER,
      status: 'open',
      escalationId: BASE_ROW.id,
      reference: 'ESC-0042',
      message: buildEscalationAcknowledgment('ESC-0042'),
    });
    expect(result.message).toBe(
      "I don't have a verified answer for that. I've logged escalation ESC-0042 for the Betco team to follow up.",
    );
  });

  it('falls back to the summary for `question`, nulls missing context, and never invents a source', async () => {
    isEscalationToolEnabledMock.mockResolvedValue(true);
    const insert = vi.fn();
    mockTables({ insert, existing: null, conversation: null });

    await runEscalationSpecialistTool(
      { reason: 'no_evidence', summary: 'Nothing on file.', specialist: 'dilution' },
      { traceId: 'trace-2', runSource: 'not-a-source' },
    );

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'Nothing on file.',
        retrieved_sources: [],
        specialist: 'dilution',
        source: null,
        workflow_run_id: null,
        conversation_id: null,
        user_id: null,
        acted_by_user_id: null,
      }),
    );
  });

  it('is at-most-once per workflow run: a second call returns the existing reference, no insert', async () => {
    isEscalationToolEnabledMock.mockResolvedValue(true);
    const insert = vi.fn();
    mockTables({ insert, existing: BASE_ROW, conversation: null });

    const result = await runEscalationSpecialistTool(VALID_ARGS, CTX);

    expect(insert).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      duplicate: true,
      reference: 'ESC-0042',
      message: buildEscalationAcknowledgment('ESC-0042'),
    });
  });

  it('rejects malformed args before touching the database', async () => {
    isEscalationToolEnabledMock.mockResolvedValue(true);
    const insert = vi.fn();
    mockTables({ insert, existing: null, conversation: null });

    await expect(runEscalationSpecialistTool({ reason: 'bogus', summary: 's' }, CTX)).rejects.toBeTruthy();
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe('runEscalationSpecialistTool — gated off (B0-528)', () => {
  it('returns a structured disabled result and writes nothing', async () => {
    isEscalationToolEnabledMock.mockResolvedValue(false);
    const insert = vi.fn();
    mockTables({ insert, existing: null, conversation: null });

    const result = await runEscalationSpecialistTool(VALID_ARGS, CTX);

    expect(fromMock).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      adapter: ESCALATION_TOOL_ADAPTER,
      status: 'disabled',
      escalationId: null,
      reference: null,
      message: ESCALATION_DISABLED_MESSAGE,
    });
  });
});
