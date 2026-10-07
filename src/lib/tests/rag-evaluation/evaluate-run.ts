import { randomUUID } from 'node:crypto';

import {
  getTestById,
  getTestItemsByTestId,
  getTestResultById,
  listAllResultItemsByResultId,
} from '~/lib/tests/repository';
import { buildRetrievalEvalRecords } from '~/lib/tests/retrieval-dataset';
import { isCompletedRunStatus, type TestItemRecord } from '~/lib/tests/types';

import { toRetrievalEpisodes } from './adapters/from-retrieval-eval-record';
import { scoreRetrievalRun } from './engine';
import { buildJudgementsFromExpectedSources } from './judgements-from-expected-sources';
import {
  claimPendingRagEvaluation,
  completeRagEvaluation,
  failRagEvaluation,
  getRagEvaluation,
  queueRagEvaluation,
  type ParsedRagEvaluation,
} from './persistence';
import { buildSnapshot } from './snapshot';
import { DEFAULT_SCORING_OPTIONS } from './types';

export type EvaluateRagRunResult =
  | { state: 'ready'; evaluation: ParsedRagEvaluation }
  | { state: 'already_running'; evaluation: ParsedRagEvaluation }
  | { state: 'not_eligible'; reason: string };

export async function isRagEvaluationEligible(testResultId: string): Promise<{
  eligible: boolean;
  reason: string | null;
}> {
  const run = await getTestResultById(testResultId).catch(() => null);
  if (!run) return { eligible: false, reason: 'run_not_found' };
  if (!isCompletedRunStatus(run.status)) return { eligible: false, reason: 'run_not_completed' };
  if (run.run_mode !== 'full') return { eligible: false, reason: 'full_runs_only' };

  const items = await getTestItemsByTestId(run.test_id);
  if (!items.some((item) => (item.expected_sources ?? []).some((source) => source.trim()))) {
    return { eligible: false, reason: 'no_expected_sources' };
  }
  return { eligible: true, reason: null };
}

export async function evaluateAndPersistRagRun(
  testResultId: string,
  options: { force?: boolean } = {},
): Promise<EvaluateRagRunResult> {
  const eligibility = await isRagEvaluationEligible(testResultId);
  if (!eligibility.eligible) {
    return { state: 'not_eligible', reason: eligibility.reason ?? 'not_eligible' };
  }

  const queued = await queueRagEvaluation(testResultId, { force: options.force });
  if (queued.status === 'ready' && !options.force) return { state: 'ready', evaluation: queued };
  if (queued.status === 'running' && !options.force) {
    return { state: 'already_running', evaluation: queued };
  }

  const claimed = await claimPendingRagEvaluation(testResultId);
  if (!claimed) {
    const current = await getRagEvaluation(testResultId);
    if (current?.status === 'ready') return { state: 'ready', evaluation: current };
    if (current) return { state: 'already_running', evaluation: current };
    throw new Error(`RAG evaluation ${testResultId} disappeared before it could be claimed.`);
  }

  const claimToken = claimed.claim_token;
  if (!claimToken) throw new Error(`RAG evaluation ${testResultId} was claimed without a token.`);

  try {
    const run = await getTestResultById(testResultId);
    const test = await getTestById(run.test_id);
    const [resultItems, testItems] = await Promise.all([
      listAllResultItemsByResultId(run.id),
      getTestItemsByTestId(run.test_id),
    ]);
    if (resultItems.length === 0) throw new Error('Completed run has no result items.');

    const itemsById = new Map<string, TestItemRecord>(testItems.map((item) => [item.id, item]));
    const records = await buildRetrievalEvalRecords(resultItems, itemsById);
    const episodes = toRetrievalEpisodes(records, {
      runId: run.id,
      questionSetId: run.test_id,
      questionSetName: test.name,
    });
    const judgementExport = buildJudgementsFromExpectedSources(testItems);
    const scoring = scoreRetrievalRun(
      episodes,
      judgementExport.judgements,
      DEFAULT_SCORING_OPTIONS,
    );
    const createdAt = new Date().toISOString();
    const snapshot = buildSnapshot({
      snapshotId: randomUUID(),
      createdAt,
      runId: run.id,
      questionSetId: run.test_id,
      questionSetName: test.name,
      label: 'dashboard-auto',
      options: DEFAULT_SCORING_OPTIONS,
      episodeCount: episodes.length,
      coverage: scoring.coverage,
      labelling: {
        items: scoring.labelling.items,
        judgements: scoring.labelling.judgements,
        labelled: scoring.labelling.labelledItemIds.length,
        unlabelled: scoring.labelling.unlabelledItemIds.length,
        documentLabelled: scoring.labelling.documentLabelledItemIds.length,
        entityLabelled: scoring.labelling.entityLabelledItemIds.length,
        orphanJudgements: scoring.labelling.orphanJudgementItemIds.length,
        labelledShare: scoring.labelling.labelledShare,
      },
      episodes: scoring.episodes,
      aggregates: scoring.aggregates,
      unscorableByReason: scoring.unscorableByReason,
      notes: null,
    });

    return {
      state: 'ready',
      evaluation: await completeRagEvaluation(testResultId, claimToken, snapshot),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failRagEvaluation(testResultId, claimToken, message).catch(() => null);
    throw error;
  }
}
