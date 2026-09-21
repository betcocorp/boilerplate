import { randomUUID } from 'node:crypto';

import { assertSupabaseNoError as assertNoError } from '~/lib/utils';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import type { Json, Tables } from '~/types/supabase.public';

import { parseSnapshot, type Snapshot } from './snapshot';

export type RagEvaluationRecord = Tables<'test_result_rag_evaluations'>;
export type RagEvaluationStatus = 'pending' | 'running' | 'ready' | 'failed';

export type ParsedRagEvaluation = Omit<RagEvaluationRecord, 'snapshot' | 'status'> & {
  status: RagEvaluationStatus;
  snapshot: Snapshot | null;
};

const CLAIM_LEASE_MS = 10 * 60 * 1000;

function parseRecord(row: RagEvaluationRecord): ParsedRagEvaluation {
  if (row.snapshot !== null) {
    const parsed = parseSnapshot(row.snapshot);
    if (parsed.ok) {
      return { ...row, status: row.status as RagEvaluationStatus, snapshot: parsed.snapshot };
    }
    return {
      ...row,
      status: 'failed',
      snapshot: null,
      error_message: `Stored RAG snapshot is invalid: ${parsed.error}`,
    };
  }
  return { ...row, status: row.status as RagEvaluationStatus, snapshot: null };
}

export async function getRagEvaluation(
  testResultId: string,
): Promise<ParsedRagEvaluation | null> {
  const result = await getSupabaseServiceRoleClient()
    .from('test_result_rag_evaluations')
    .select('*')
    .eq('test_result_id', testResultId)
    .maybeSingle();
  const row = assertNoError(result) as RagEvaluationRecord | null;
  return row ? parseRecord(row) : null;
}

function leaseIsExpired(evaluation: ParsedRagEvaluation): boolean {
  if (!evaluation.lease_expires_at) return true;
  return new Date(evaluation.lease_expires_at).getTime() <= Date.now();
}

export async function queueRagEvaluation(
  testResultId: string,
  options: { force?: boolean } = {},
): Promise<ParsedRagEvaluation> {
  const existing = await getRagEvaluation(testResultId);
  const shouldReset =
    options.force === true || (existing?.status === 'running' && leaseIsExpired(existing));

  if (existing && !shouldReset) return existing;

  const payload = {
    test_result_id: testResultId,
    status: 'pending',
    snapshot: null,
    error_message: null,
    completed_at: null,
    claim_token: null,
    lease_expires_at: null,
  };

  if (existing) {
    let query = getSupabaseServiceRoleClient()
      .from('test_result_rag_evaluations')
      .update(payload)
      .eq('test_result_id', testResultId);
    if (existing.claim_token) query = query.eq('claim_token', existing.claim_token);
    assertNoError(await query);
  } else {
    // insert-on-conflict makes simultaneous automatic/manual queue attempts converge on one row.
    assertNoError(
      await getSupabaseServiceRoleClient()
        .from('test_result_rag_evaluations')
        .upsert(payload, { onConflict: 'test_result_id', ignoreDuplicates: true }),
    );
  }

  const queued = await getRagEvaluation(testResultId);
  if (!queued) throw new Error(`Failed to queue RAG evaluation ${testResultId}.`);
  return queued;
}

/** Atomically claims pending work and leases it to one invocation. */
export async function claimPendingRagEvaluation(
  testResultId: string,
): Promise<ParsedRagEvaluation | null> {
  const claimToken = randomUUID();
  const result = await getSupabaseServiceRoleClient()
    .from('test_result_rag_evaluations')
    .update({
      status: 'running',
      error_message: null,
      claim_token: claimToken,
      lease_expires_at: new Date(Date.now() + CLAIM_LEASE_MS).toISOString(),
    })
    .eq('test_result_id', testResultId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  const row = assertNoError(result) as RagEvaluationRecord | null;
  return row ? parseRecord(row) : null;
}

export async function completeRagEvaluation(
  testResultId: string,
  claimToken: string,
  snapshot: Snapshot,
): Promise<ParsedRagEvaluation> {
  const result = await getSupabaseServiceRoleClient()
    .from('test_result_rag_evaluations')
    .update({
      status: 'ready',
      snapshot: JSON.parse(JSON.stringify(snapshot)) as Json,
      error_message: null,
      completed_at: new Date().toISOString(),
      claim_token: null,
      lease_expires_at: null,
    })
    .eq('test_result_id', testResultId)
    .eq('claim_token', claimToken)
    .select('*')
    .maybeSingle();
  const row = assertNoError(result) as RagEvaluationRecord | null;
  if (!row) throw new Error(`RAG evaluation ${testResultId} claim was superseded before completion.`);
  return parseRecord(row);
}

export async function failRagEvaluation(
  testResultId: string,
  claimToken: string,
  errorMessage: string,
): Promise<ParsedRagEvaluation | null> {
  const result = await getSupabaseServiceRoleClient()
    .from('test_result_rag_evaluations')
    .update({
      status: 'failed',
      error_message: errorMessage.slice(0, 4000),
      completed_at: new Date().toISOString(),
      claim_token: null,
      lease_expires_at: null,
    })
    .eq('test_result_id', testResultId)
    .eq('claim_token', claimToken)
    .select('*')
    .maybeSingle();
  const row = assertNoError(result) as RagEvaluationRecord | null;
  return row ? parseRecord(row) : null;
}
