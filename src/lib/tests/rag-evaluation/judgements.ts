/**
 * Ground-truth loading for Phase 3.
 *
 * `Judgement` (see `types.ts`) is produced by the labelling work — D1 (who curates relevant chunk
 * ids), D2 (harvest vs. label independently) and D4 (reference answers) — none of which is settled.
 * This module is the boundary that work lands on, and it is written so that the honest current
 * state, "almost nothing is labelled", is representable and reported rather than silently scored.
 *
 * ## Unlabelled is not zero
 *
 * The contract is explicit: an item with no `relevantDocuments` and `isNegative: false` is
 * *unlabelled*, not "nothing was relevant". Scoring it yields recall 0, which averages into the
 * headline and reads as a retrieval failure. So:
 *
 * - a missing judgement produces no score — the caller emits `unscorable('no_judgement')`;
 * - a *present but empty* judgement is treated the same way, because a file half-filled by a
 *   labelling pass in progress is the normal case, not an anomaly;
 * - an explicit negative (`isNegative: true`) IS labelled, and is scoreable: "retrieve nothing" is a
 *   real expectation with a real answer.
 *
 * Labelling can also be partial by *dimension*: an item may carry entity requirements while its
 * relevant-document set is still empty, or vice versa. {@link summarizeLabellingCoverage} therefore
 * reports both dimensions separately, so a run does not claim document-recall coverage it does not
 * have.
 *
 * ## Orphan judgements
 *
 * Judgements are keyed by `test_items.id`. A question set edited after labelling leaves judgements
 * whose item no longer exists in the run. Those are reported, never dropped in silence — an orphan
 * count that jumps is how you find out a set was re-seeded underneath the labels.
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import type { EntityKind, Judgement, RetrievalEpisode } from './types';

const entityKindSchema = z.enum([
  'epa_registration',
  'din',
  'dilution',
  'contact_time',
  'literal',
]) satisfies z.ZodType<EntityKind>;

const documentRelevanceSchema = z.object({
  documentId: z.string().min(1),
  /** Graded gain: 0 irrelevant, 1 related, 2 answers the question. Non-negative, finite. */
  gain: z.number().finite().min(0),
});

const entityRequirementSchema = z.object({
  key: z.string().min(1),
  kind: entityKindSchema,
  /** At least one accepted surface form, or the requirement can never be satisfied. */
  values: z.array(z.string().min(1)).min(1),
  required: z.boolean(),
});

export const judgementSchema = z.object({
  itemId: z.string().min(1),
  relevantDocuments: z.array(documentRelevanceSchema).default([]),
  entities: z.array(entityRequirementSchema).default([]),
  isNegative: z.boolean().default(false),
  notes: z.string().nullable().default(null),
});

/**
 * The judgement list itself. The file may hold this array bare, or wrapped as `{ judgements: [...] }`
 * — the wrapper exists because a labelling export will want somewhere to put its own provenance (who
 * labelled, when, from which run) without that metadata having to masquerade as a judgement.
 *
 * The wrapper is unwrapped BEFORE validation rather than expressed as a `z.union`, because a union
 * reports its failure at the root: `0.entities.0.kind` becomes `<root>: invalid input`, and an
 * issue path is the only part of a validation error a labeller can act on.
 */
export const judgementListSchema = z.array(judgementSchema);

export type JudgementParseIssue = {
  /** Dotted path into the file, e.g. `judgements.3.entities.0.kind`. */
  path: string;
  message: string;
};

export type JudgementLoadResult =
  | { ok: true; judgements: Judgement[]; source: string }
  | { ok: false; issues: JudgementParseIssue[]; source: string };

/** Accepts a bare array or `{ judgements: [...] }`, so issue paths stay relative to the list. */
function unwrapJudgementList(
  raw: unknown,
): { ok: true; list: unknown } | { ok: false; message: string } {
  if (Array.isArray(raw)) return { ok: true, list: raw };
  if (typeof raw === 'object' && raw !== null && 'judgements' in raw) {
    return { ok: true, list: (raw as { judgements: unknown }).judgements ?? [] };
  }
  return {
    ok: false,
    message: 'Expected an array of judgements, or an object with a `judgements` array.',
  };
}

/** Validates already-parsed JSON. Pure — the file read is separate so tests need no fixture files. */
export function parseJudgements(raw: unknown, source = '<memory>'): JudgementLoadResult {
  const unwrapped = unwrapJudgementList(raw);
  if (!unwrapped.ok) {
    return { ok: false, source, issues: [{ path: '<root>', message: unwrapped.message }] };
  }

  const parsed = judgementListSchema.safeParse(unwrapped.list);
  if (!parsed.success) {
    return {
      ok: false,
      source,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '<root>',
        message: issue.message,
      })),
    };
  }

  const judgements = parsed.data;

  const seen = new Set<string>();
  const duplicates: JudgementParseIssue[] = [];
  for (const [i, judgement] of judgements.entries()) {
    if (seen.has(judgement.itemId)) {
      duplicates.push({
        path: `${i}.itemId`,
        // Two judgements for one item is ambiguous ground truth: silently taking the last one would
        // make the score depend on file order.
        message: `Duplicate judgement for itemId ${judgement.itemId}`,
      });
    }
    seen.add(judgement.itemId);
  }
  if (duplicates.length > 0) {
    return { ok: false, source, issues: duplicates };
  }

  return { ok: true, source, judgements };
}

/**
 * Reads and validates a judgements JSON file.
 *
 * A missing file is NOT an error: before D1/D2 land there is no file, and the runner must still be
 * able to report coverage. It resolves to zero judgements, which every item then reports as
 * unlabelled. Malformed JSON *is* an error — a file that exists and cannot be read is a mistake, not
 * an absence.
 */
export async function loadJudgementsFile(filePath: string): Promise<JudgementLoadResult> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, judgements: [], source: filePath };
    }
    throw error;
  }

  if (text.trim() === '') {
    return { ok: true, judgements: [], source: filePath };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      source: filePath,
      issues: [{ path: '<root>', message: `Invalid JSON: ${(error as Error).message}` }],
    };
  }

  return parseJudgements(raw, filePath);
}

/** Keyed by `itemId` for the per-episode lookup. */
export function indexJudgements(judgements: Judgement[]): Map<string, Judgement> {
  return new Map(judgements.map((judgement) => [judgement.itemId, judgement]));
}

/**
 * True when the judgement asserts nothing. Present-but-empty is the same evidential state as absent,
 * and must produce the same `no_judgement` outcome.
 */
export function isUnlabelled(judgement: Judgement | undefined): boolean {
  if (!judgement) return true;
  if (judgement.isNegative) return false;
  return judgement.relevantDocuments.length === 0 && judgement.entities.length === 0;
}

/** True when document-recall / rank metrics have something to score against. */
export function hasDocumentLabels(judgement: Judgement | undefined): boolean {
  if (!judgement) return false;
  return judgement.isNegative || judgement.relevantDocuments.length > 0;
}

/** True when entity recall has something to score against. */
export function hasEntityLabels(judgement: Judgement | undefined): boolean {
  return Boolean(judgement && judgement.entities.length > 0);
}

export type LabellingCoverage = {
  episodes: number;
  /** Distinct `itemId`s across the episodes — a run may repeat an item across rows. */
  items: number;
  judgements: number;
  /** Item ids with a judgement that asserts something (documents, entities, or an explicit negative). */
  labelledItemIds: string[];
  /** Item ids with no judgement, or one that asserts nothing. */
  unlabelledItemIds: string[];
  /** Subset of labelled items usable by rank/document metrics. */
  documentLabelledItemIds: string[];
  /** Subset of labelled items usable by entity recall. */
  entityLabelledItemIds: string[];
  /** Judgements whose `itemId` appears in no episode — a stale or re-seeded question set. */
  orphanJudgementItemIds: string[];
  /** `labelled / items`; null when there are no items, never 0. */
  labelledShare: number | null;
};

/**
 * Reports what is and is not labelled, without scoring anything.
 *
 * This is the number to read before any mean: a rank metric averaged over 6 of 20 episodes is a
 * different claim from one averaged over 20, and the two are indistinguishable once printed.
 */
export function summarizeLabellingCoverage(
  episodes: RetrievalEpisode[],
  judgements: Judgement[],
): LabellingCoverage {
  const byItemId = indexJudgements(judgements);
  const itemIds = [...new Set(episodes.map((episode) => episode.itemId))];

  const labelledItemIds: string[] = [];
  const unlabelledItemIds: string[] = [];
  const documentLabelledItemIds: string[] = [];
  const entityLabelledItemIds: string[] = [];

  for (const itemId of itemIds) {
    const judgement = byItemId.get(itemId);
    if (isUnlabelled(judgement)) {
      unlabelledItemIds.push(itemId);
    } else {
      labelledItemIds.push(itemId);
    }
    if (hasDocumentLabels(judgement)) documentLabelledItemIds.push(itemId);
    if (hasEntityLabels(judgement)) entityLabelledItemIds.push(itemId);
  }

  const episodeItemIds = new Set(itemIds);
  const orphanJudgementItemIds = judgements
    .map((judgement) => judgement.itemId)
    .filter((itemId) => !episodeItemIds.has(itemId));

  return {
    episodes: episodes.length,
    items: itemIds.length,
    judgements: judgements.length,
    labelledItemIds,
    unlabelledItemIds,
    documentLabelledItemIds,
    entityLabelledItemIds,
    orphanJudgementItemIds,
    labelledShare: itemIds.length > 0 ? labelledItemIds.length / itemIds.length : null,
  };
}
