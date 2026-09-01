/**
 * B0-496 — the confidence & similarity integrity read model (epic B0-489).
 *
 * The question the epic exists to answer is "is every point in a run that changes the outcome
 * actually measured?". Today that is answered by reading
 * `~/lib/workflows/product-support/run-product-support-workflow.ts` end to end. This module turns it
 * into data: one row per decision node, each either carrying the record the node emitted or saying
 * `unmeasured` — the panel's job is to SHOW gaps, never to hide them behind a blank cell.
 *
 * NODE ENUMERATION IS CODE-ANCHORED. The ticket points at a design doc (`claude/
 * prompt-observability-design.md` §1) that does not exist in this repo, so the registry below is
 * derived from the workflow itself: the ten `gateIdSchema` values it writes, the five
 * `activeGatesSchema` activation keys it resolves, and the run-level measurement fields B0-490
 * (`similaritySummary`), B0-491 (`agentConfidence*`), B0-492 (`confidenceProvenance*`), B0-493
 * (`retrievalConfig`) and B0-494 (`runtimeConfig`) persist. `findDecisionNodeCoverageGaps` re-checks
 * the registry against those enums, so a gate added next quarter without a node here fails the build
 * (`integrity-coverage.test.ts`) instead of going silently unmeasured — which is exactly how four
 * rule gates escaped measurement before B0-391.
 *
 * PURE: no React, no I/O. It reads only what is already persisted on `workflow_runs.final_output`
 * and `workflow_steps.output`.
 */

import {
  CONFIDENCE_PROVENANCES,
  isJudgmentProvenance,
  resolveConfidenceProvenance,
} from '~/lib/workflows/product-support/confidence-provenance';
import {
  activeGatesSchema,
  gateIdSchema,
  readStepGateRecords,
  retrievalConfigSummarySchema,
  runtimeConfigSchema,
  similaritySummarySchema,
} from '~/lib/workflows/product-support/product-support-schemas';

import type { ConfidenceProvenance } from '~/lib/workflows/product-support/confidence-provenance';
import type {
  ActiveGates,
  GateActivationRecord,
  GateId,
  GateRecord,
  RetrievalConfigSummary,
  RuntimeConfig,
  SimilaritySummary,
} from '~/lib/workflows/product-support/product-support-schemas';

/* -------------------------------------------------------------------------- *
 * Decision-node registry
 * -------------------------------------------------------------------------- */

/**
 * Every node below is derived from what the code actually emits — `gateIdSchema`,
 * `activeGatesSchema` and the B0-490…B0-494 run-level fields — NOT from
 * `claude/prompt-observability-design.md`, which the ticket cites but which does not
 * exist in this repo.
 *
 * This list is deliberately in sync with `gateIdSchema` as committed, and nothing more.
 * When a new gate lands, `integrity-coverage.test.ts` FAILS naming it, and registering
 * it here is the fix. That failure is the feature — it is the whole reason B0-496 exists,
 * so do not relax the assertion to make a red build green.
 */
export const DECISION_NODE_IDS = [
  'keyword_routing',
  'llm_intent_classifier',
  'semantic_router',
  // B0-786 — the consolidated pre-orchestration signals call.
  'signals_analysis',
  'competitor_identity_resolution',
  'early_decline_gate',
  'validator',
  'usage_safety_coverage',
  'regulated_claim_guardrail',
  'recommendation_confidence',
  'agent_self_confidence',
  'confidence_provenance',
  'similarity_rollup',
  'retrieval_config',
  'runtime_config',
] as const;

export type DecisionNodeId = (typeof DECISION_NODE_IDS)[number];

/**
 * `measured` — the node executed and its record is on the run.
 * `unmeasured` — the node executed (or always executes) and emitted NO record: the gap this panel
 *   exists to surface.
 * `unknown` — nothing persisted says whether it executed, so absence cannot be read as either.
 * `skipped` — disabled by a flag; never evaluated.
 * `bypassed` — it evaluated, but the B0-452 kill switch suppressed the effect.
 * `not_applicable` — its own trigger condition never occurred this turn.
 */
export type DecisionNodeStatus =
  | 'measured'
  | 'unmeasured'
  | 'unknown'
  | 'skipped'
  | 'bypassed'
  | 'not_applicable';

export type DecisionNodeKind = 'routing' | 'gate' | 'confidence' | 'retrieval' | 'runtime';

type NodeContext = {
  finalOutput: Record<string, unknown> | null;
  gateRecordsByGateId: Map<GateId, GateRecord[]>;
  activeGates: ActiveGates | null;
  runtimeConfig: RuntimeConfig | null;
  stepNames: Set<string>;
  /** The early-decline gate produced the answer, so the tool loop never ran. */
  isDeclineRun: boolean;
};

type NodeResolution = {
  status: DecisionNodeStatus;
  detail: string;
  /** Persisted field paths that back this row. Empty when the node is unmeasured. */
  evidence: string[];
};

export type DecisionNodeDefinition = {
  id: DecisionNodeId;
  label: string;
  kind: DecisionNodeKind;
  /** What changes about the run's outcome when this node fires. */
  changesOutcome: string;
  /** Where the record is expected to live when the node executes. */
  recordedAt: string;
  /** `gateIdSchema` values this node owns. Every value must be owned by exactly one node. */
  gateIds: readonly GateId[];
  /** `activeGatesSchema` key this node owns, when B0-494 tracks its activation. */
  activationKey: keyof ActiveGates | null;
  resolve: (ctx: NodeContext) => NodeResolution;
};

export type DecisionNodeCoverageRow = Omit<DecisionNodeDefinition, 'resolve'> &
  NodeResolution & {
    /** The gate records this node emitted, in evaluation order. Verbatim — never reworded. */
    records: GateRecord[];
    /** B0-494 activation, when this node has one. */
    activation: GateActivationRecord | null;
  };

/* -------------------------------------------------------------------------- *
 * Shared resolvers
 * -------------------------------------------------------------------------- */

function hasKey(record: Record<string, unknown> | null, key: string): boolean {
  return record !== null && key in record && record[key] !== undefined;
}

/**
 * The common shape for the five gates B0-494 tracks an activation state for. `ran` is the only
 * state that can be a gap: every other state is itself a recorded measurement.
 *
 * `gateRecordRequiredWhenRan` is false for the gates whose activation record IS the measurement —
 * the validator (its `workflow_steps` row carries the verdict), the early-decline gate (`ran` there
 * means "was enabled", and a gate record only exists on the run it actually declined) and the
 * regulated-claim guardrail (which only writes a record on the bypassed path).
 */
function resolveActivationBackedGate(options: {
  activationKey: keyof ActiveGates;
  gateIds: readonly GateId[];
  gateRecordRequiredWhenRan: boolean;
  /** Extra step row that must exist when the gate ran (the validator's own step). */
  requiredStepName?: string;
  /**
   * The ticket that made this key optional on `activeGatesSchema`, when it is not one of the five
   * B0-494 originals — an absent optional key means "the run predates THAT gate", not B0-494.
   */
  activationAddedBy?: string;
}) {
  return (ctx: NodeContext): NodeResolution => {
    const records = options.gateIds.flatMap((id) => ctx.gateRecordsByGateId.get(id) ?? []);
    const recordEvidence = records.map(
      (record) => `workflow_steps[*].output.gates[gate=${record.gate}]`,
    );
    const activation = ctx.activeGates?.[options.activationKey] ?? null;

    const predates = options.activationAddedBy ?? 'B0-494';
    if (!activation) {
      return records.length > 0
        ? {
            status: 'measured',
            detail: `Gate record present, but this run predates ${predates} so its activation state (ran / skipped / bypassed) was never recorded.`,
            evidence: recordEvidence,
          }
        : {
            status: 'unknown',
            detail: `No activation state and no gate record. This run predates ${predates}, so nothing persisted says whether this gate ran — absence is not evidence that it did not.`,
            evidence: [],
          };
    }

    const activationEvidence = `final_output.activeGates.${options.activationKey}`;

    if (activation.state === 'skipped') {
      return {
        status: 'skipped',
        detail: `Disabled by flag (${activation.reason ?? 'no reason recorded'}); never evaluated.`,
        evidence: [activationEvidence, ...recordEvidence],
      };
    }
    if (activation.state === 'bypassed') {
      return {
        status: 'bypassed',
        detail: `Evaluated, but its effect was suppressed (${activation.reason ?? 'no reason recorded'}); the cap or rejection was not enforced.`,
        evidence: [activationEvidence, ...recordEvidence],
      };
    }
    if (activation.state === 'not_applicable') {
      return {
        status: 'not_applicable',
        detail: 'This gate’s own trigger condition never occurred on this run.',
        evidence: [activationEvidence, ...recordEvidence],
      };
    }

    if (options.requiredStepName && !ctx.stepNames.has(options.requiredStepName)) {
      return {
        status: 'unmeasured',
        detail: `Recorded as having run, but no "${options.requiredStepName}" workflow_steps row exists to carry its verdict.`,
        evidence: [activationEvidence],
      };
    }
    if (options.gateRecordRequiredWhenRan && records.length === 0) {
      return {
        status: 'unmeasured',
        detail: 'Recorded as having run, but emitted no gate record saying what it decided.',
        evidence: [activationEvidence],
      };
    }
    return {
      status: 'measured',
      detail:
        records.length > 0
          ? `Ran and recorded ${records.length} verdict${records.length === 1 ? '' : 's'}.`
          : 'Ran; its activation state is the record (this gate emits a gate record only on the paths noted above).',
      evidence: [activationEvidence, ...recordEvidence],
    };
  };
}

/** A run-level measurement field: present ⇒ measured, absent ⇒ unmeasured (or n/a on a decline run). */
function resolvePayloadField(options: {
  field: string;
  /** Extra fields recorded alongside, listed as evidence when present. */
  companionFields?: readonly string[];
  /** True when the tool loop never running makes the field legitimately absent. */
  notApplicableOnDeclineRun?: boolean;
  measuredDetail: string;
  missingDetail: string;
}) {
  return (ctx: NodeContext): NodeResolution => {
    if (hasKey(ctx.finalOutput, options.field)) {
      const companions = (options.companionFields ?? []).filter((field) =>
        hasKey(ctx.finalOutput, field),
      );
      return {
        status: 'measured',
        detail: options.measuredDetail,
        evidence: [`final_output.${options.field}`, ...companions.map((f) => `final_output.${f}`)],
      };
    }
    if (options.notApplicableOnDeclineRun && ctx.isDeclineRun) {
      return {
        status: 'not_applicable',
        detail:
          'The early-decline gate answered this run, so no retrieval or tool loop ran to measure.',
        evidence: ['final_output.answerProvenance=decline_gate'],
      };
    }
    return { status: 'unmeasured', detail: options.missingDetail, evidence: [] };
  };
}

/* -------------------------------------------------------------------------- *
 * The registry
 * -------------------------------------------------------------------------- */

export const DECISION_NODES: readonly DecisionNodeDefinition[] = [
  {
    id: 'keyword_routing',
    label: 'Keyword routing scores',
    kind: 'routing',
    changesOutcome: 'Picks the specialist prompt and the route-scoped tool schemas.',
    recordedAt: 'workflow_steps[orchestration_planner].output.gates[gate=keyword_routing]',
    gateIds: ['keyword_routing'],
    activationKey: null,
    resolve: (ctx) => {
      const records = ctx.gateRecordsByGateId.get('keyword_routing') ?? [];
      if (records.length > 0) {
        return {
          status: 'measured',
          detail: `Scored and recorded (verdict: ${records[0].verdict}).`,
          evidence: ['workflow_steps[orchestration_planner].output.gates[gate=keyword_routing]'],
        };
      }
      return {
        status: 'unmeasured',
        detail:
          'The keyword router scores every run unconditionally, so a missing record is a gap — not a route that never ran.',
        evidence: [],
      };
    },
  },
  {
    id: 'llm_intent_classifier',
    label: 'LLM intent classifier',
    kind: 'routing',
    changesOutcome:
      'Since the B0-497/511 cutover it decides the route outright; in shadow mode it only compares.',
    recordedAt:
      'workflow_steps[orchestration_planner].output.gates[gate=llm_intent_classifier_live|_shadow]',
    gateIds: ['llm_intent_classifier_live', 'llm_intent_classifier_shadow'],
    activationKey: null,
    resolve: (ctx) => {
      const records = [
        ...(ctx.gateRecordsByGateId.get('llm_intent_classifier_live') ?? []),
        ...(ctx.gateRecordsByGateId.get('llm_intent_classifier_shadow') ?? []),
      ];
      if (records.length > 0) {
        return {
          status: 'measured',
          detail: `Classified and recorded (${records.map((r) => `${r.gate}: ${r.verdict}`).join('; ')}).`,
          evidence: records.map((r) => `workflow_steps[*].output.gates[gate=${r.gate}]`),
        };
      }
      return {
        status: 'unknown',
        detail:
          'No classifier record. `runtimeConfig` carries no LLM-router switch, so nothing on this run distinguishes "the classifier was kill-switched" from "it ran and recorded nothing".',
        evidence: [],
      };
    },
  },
  {
    id: 'semantic_router',
    label: 'Semantic router',
    kind: 'routing',
    changesOutcome:
      'When live and confident it overrides the keyword route; when shadowed it only compares.',
    recordedAt:
      'workflow_steps[orchestration_planner].output.gates[gate=semantic_router_live|_shadow]',
    gateIds: ['semantic_router_live', 'semantic_router_shadow'],
    activationKey: null,
    resolve: (ctx) => {
      const records = [
        ...(ctx.gateRecordsByGateId.get('semantic_router_live') ?? []),
        ...(ctx.gateRecordsByGateId.get('semantic_router_shadow') ?? []),
      ];
      if (records.length > 0) {
        return {
          status: 'measured',
          detail: `Scored and recorded (${records.map((r) => `${r.gate}: ${r.verdict}`).join('; ')}).`,
          evidence: records.map((r) => `workflow_steps[*].output.gates[gate=${r.gate}]`),
        };
      }
      if (ctx.runtimeConfig?.semanticRouterEnabled === false) {
        return {
          status: 'skipped',
          detail: 'Disabled by flag on this run; never called.',
          evidence: ['final_output.runtimeConfig.semanticRouterEnabled'],
        };
      }
      if (ctx.runtimeConfig?.semanticRouterEnabled === true) {
        return {
          status: 'unmeasured',
          detail: 'Recorded as enabled for this run, but emitted no routing record.',
          evidence: ['final_output.runtimeConfig.semanticRouterEnabled'],
        };
      }
      return {
        status: 'unknown',
        detail:
          'No record and no `runtimeConfig.semanticRouterEnabled`: this run predates B0-649, so whether the router ran was never captured.',
        evidence: [],
      };
    },
  },
  {
    id: 'signals_analysis',
    label: 'Consolidated signals analysis',
    kind: 'routing',
    changesOutcome:
      "B0-786 — one pre-orchestration call supplies the turn's route, cross-reference intent, competitor identity, answer shape, decline class and regulated-section intent.",
    recordedAt: 'workflow_steps[orchestration_planner].output.gates[gate=signals_analysis]',
    gateIds: ['signals_analysis'],
    activationKey: null,
    resolve: (ctx) => {
      const records = ctx.gateRecordsByGateId.get('signals_analysis') ?? [];
      if (records.length > 0) {
        return {
          status: 'measured',
          detail: `Analyzed and recorded (${records[0].verdict}).`,
          evidence: ['workflow_steps[orchestration_planner].output.gates[gate=signals_analysis]'],
        };
      }
      return {
        status: 'skipped',
        detail:
          'No signals record: `BEX_SIGNALS_ANALYSIS_ENABLED` was off (its default) for this run, or the run predates B0-786 — the scattered classifier + keyword path decided instead.',
        evidence: [],
      };
    },
  },
  {
    id: 'competitor_identity_resolution',
    label: 'Competitor identity resolution',
    kind: 'gate',
    changesOutcome:
      'Picks the one (brand, product) tuple every cross-reference lookup, override and web-search backstop reuses.',
    recordedAt: 'workflow_steps[*].output.gates[gate=competitor_identity_resolution]',
    gateIds: ['competitor_identity_resolution'],
    activationKey: null,
    resolve: (ctx) => {
      const records = ctx.gateRecordsByGateId.get('competitor_identity_resolution') ?? [];
      if (records.length > 0) {
        return {
          status: 'measured',
          detail: `Resolved and recorded (verdict: ${records[0].verdict}).`,
          evidence: ['workflow_steps[*].output.gates[gate=competitor_identity_resolution]'],
        };
      }
      if (hasKey(ctx.finalOutput, 'resolvedCompetitor')) {
        return {
          status: 'unmeasured',
          detail:
            'A competitor tuple was resolved on this run (`final_output.resolvedCompetitor`), but the resolution emitted no gate record.',
          evidence: ['final_output.resolvedCompetitor'],
        };
      }
      return {
        status: 'not_applicable',
        detail: 'This turn never entered the cross-reference path, so no competitor was resolved.',
        evidence: [],
      };
    },
  },
  {
    id: 'early_decline_gate',
    label: 'Early decline gate',
    kind: 'gate',
    changesOutcome:
      'Short-circuits the whole run before any model call, with a fixed 0.92 confidence constant.',
    recordedAt:
      'final_output.activeGates.earlyDeclineGate + workflow_steps[early_decline_gate].output.gates[]',
    gateIds: ['early_decline_gate'],
    activationKey: 'earlyDeclineGate',
    resolve: resolveActivationBackedGate({
      activationKey: 'earlyDeclineGate',
      gateIds: ['early_decline_gate'],
      gateRecordRequiredWhenRan: false,
    }),
  },
  {
    id: 'validator',
    label: 'Validator pass',
    kind: 'gate',
    changesOutcome:
      'Approves or rejects the draft and sets the judged confidence; bypassed it substitutes a regex-shaped constant.',
    recordedAt: 'final_output.activeGates.validator + workflow_steps[validator].output',
    gateIds: [],
    activationKey: 'validator',
    resolve: resolveActivationBackedGate({
      activationKey: 'validator',
      gateIds: [],
      gateRecordRequiredWhenRan: false,
      requiredStepName: 'validator',
    }),
  },
  {
    id: 'usage_safety_coverage',
    label: 'Usage/safety coverage cap',
    kind: 'gate',
    changesOutcome: 'Caps confidence at 0.55 and forces fallback copy when usage or safety evidence is missing.',
    recordedAt:
      'final_output.activeGates.usageSafetyCoverage + workflow_steps[validator].output.gates[gate=usage_safety_coverage]',
    gateIds: ['usage_safety_coverage'],
    activationKey: 'usageSafetyCoverage',
    resolve: resolveActivationBackedGate({
      activationKey: 'usageSafetyCoverage',
      gateIds: ['usage_safety_coverage'],
      gateRecordRequiredWhenRan: true,
    }),
  },
  {
    id: 'regulated_claim_guardrail',
    label: 'Regulated-claim guardrail',
    kind: 'gate',
    changesOutcome:
      'Requires an exact verbatim quote behind every EPA/dilution/contact-time/hazard/first-aid claim; caps confidence at 0.4 and replaces the answer when one is missing.',
    recordedAt:
      'final_output.activeGates.regulatedClaimGuardrail + workflow_steps[validator].output.gates[gate=regulated_claim_guardrail] (bypassed path only)',
    gateIds: ['regulated_claim_guardrail'],
    activationKey: 'regulatedClaimGuardrail',
    resolve: resolveActivationBackedGate({
      activationKey: 'regulatedClaimGuardrail',
      gateIds: ['regulated_claim_guardrail'],
      gateRecordRequiredWhenRan: false,
    }),
  },
  {
    id: 'recommendation_confidence',
    label: 'Recommendation confidence calibration',
    kind: 'gate',
    changesOutcome:
      'Applies the low-similarity / missing-brand / category-mismatch caps on the cross-reference path.',
    recordedAt:
      'final_output.activeGates.recommendationConfidence + workflow_steps[validator].output.gates[gate=recommendation_confidence]',
    gateIds: ['recommendation_confidence'],
    activationKey: 'recommendationConfidence',
    resolve: resolveActivationBackedGate({
      activationKey: 'recommendationConfidence',
      gateIds: ['recommendation_confidence'],
      gateRecordRequiredWhenRan: true,
    }),
  },
  {
    id: 'agent_self_confidence',
    label: 'Agent self-score (B0-491)',
    kind: 'confidence',
    changesOutcome:
      'Replaces the validator/heuristic value as the recommendation gate’s baseConfidence when the model reports one.',
    recordedAt: 'final_output.agentConfidence / agentConfidenceReason / agentConfidenceBasis',
    gateIds: [],
    activationKey: null,
    resolve: resolvePayloadField({
      field: 'agentConfidenceReason',
      companionFields: ['agentConfidence', 'agentConfidenceBasis'],
      measuredDetail:
        'Recorded with an explicit reason, so a null score is never left unexplained.',
      missingDetail:
        'No `agentConfidenceReason`: this run predates B0-491, so a missing self-score cannot be told apart from a model that never reported one.',
    }),
  },
  {
    id: 'confidence_provenance',
    label: 'Confidence provenance (B0-492)',
    kind: 'confidence',
    changesOutcome:
      'Says which of the six mechanisms produced the run’s confidence, and what it was before any cap.',
    recordedAt:
      'final_output.confidenceProvenance / confidencePreCapValue / confidencePreCapProvenance',
    gateIds: [],
    activationKey: null,
    resolve: resolvePayloadField({
      field: 'confidenceProvenance',
      companionFields: ['confidencePreCapValue', 'confidencePreCapProvenance'],
      measuredDetail: 'Recorded, with the pre-cap value recoverable whenever a gate capped it.',
      missingDetail:
        'No `confidenceProvenance`: this run predates B0-492, so its confidence number is unattributable — it must be read as "unknown", never as a judgment.',
    }),
  },
  {
    id: 'similarity_rollup',
    label: 'Similarity rollup (B0-490)',
    kind: 'retrieval',
    changesOutcome:
      'The RAW top similarity is what the recommendation gate calibrates against; the selected one is what reached the model.',
    recordedAt: 'final_output.similaritySummary',
    gateIds: [],
    activationKey: null,
    resolve: resolvePayloadField({
      field: 'similaritySummary',
      notApplicableOnDeclineRun: true,
      measuredDetail:
        'Raw and post-selection top similarity recorded separately, with the count filtered out between them.',
      missingDetail:
        'No `similaritySummary`: this run predates B0-490, so raw and post-filter similarity cannot be told apart.',
    }),
  },
  {
    id: 'retrieval_config',
    label: 'Retrieval configuration (B0-493)',
    kind: 'retrieval',
    changesOutcome:
      'Determines what retrieval could return at all: embedding model, strategy, scope and the similarity floor.',
    recordedAt: 'final_output.retrievalConfig (+ rerankMsTotal, productLineLock)',
    gateIds: [],
    activationKey: null,
    resolve: resolvePayloadField({
      field: 'retrievalConfig',
      companionFields: ['rerankMsTotal', 'productLineLock'],
      notApplicableOnDeclineRun: true,
      measuredDetail:
        'The configuration every search-backed call used, with per-field disagreement listed in `mixed`.',
      missingDetail:
        'No `retrievalConfig`: this run predates B0-493, so the retrieval configuration behind its similarity numbers is unrecoverable.',
    }),
  },
  {
    id: 'runtime_config',
    label: 'Runtime switches (B0-494)',
    kind: 'runtime',
    changesOutcome:
      'The resolved value of every behavior switch the run observed — the thing that makes two runs comparable at all.',
    recordedAt: 'final_output.runtimeConfig',
    gateIds: [],
    activationKey: null,
    resolve: resolvePayloadField({
      field: 'runtimeConfig',
      companionFields: ['activeGates'],
      measuredDetail: 'Resolved values recorded (never flag names, which can resolve differently per deploy).',
      missingDetail:
        'No `runtimeConfig`: this run predates B0-494, so which gates were even enabled is unknown — it must not be read as "all enabled".',
    }),
  },
];

/* -------------------------------------------------------------------------- *
 * Confidence and similarity observations
 * -------------------------------------------------------------------------- */

/**
 * One confidence number on the run, together with the mechanism that produced it and the field it
 * was read from. Provenance is never optional: B0-492's AC is that no confidence renders anywhere
 * without it, so an unattributable historical value resolves to `'unknown'` rather than to nothing.
 */
export type ConfidenceObservation = {
  id: string;
  label: string;
  value: number | null;
  provenance: ConfidenceProvenance;
  /** True when `provenance` is a real model judgment rather than a constant, cap or self-score. */
  isJudgment: boolean;
  /** The value before the FIRST cap in this run's chain, when a gate capped it. */
  preCapValue: number | null;
  preCapProvenance: ConfidenceProvenance | null;
  /** The persisted field this number was read from. */
  source: string;
  /** Qualifier that is not a provenance (e.g. the B0-491 reason a self-score is null). */
  note: string | null;
};

/** Per-provenance confidence stats, which is what B0-492 requires INSTEAD of one cross-run mean. */
export type ConfidenceProvenanceGroup = {
  provenance: ConfidenceProvenance;
  isJudgment: boolean;
  count: number;
  values: number[];
  min: number;
  max: number;
  /** Mean WITHIN this provenance only. Never averaged across provenances — see B0-492. */
  mean: number;
};

export type SimilarityIntegrity = {
  /** False when `similaritySummary` was never written (pre-B0-490, or no search tool ran). */
  measured: boolean;
  rawTopSimilarity: number | null;
  selectedTopSimilarity: number | null;
  droppedByFilterCount: number | null;
  /** The field these three numbers came from — their provenance. */
  source: string;
  note: string;
};

export type RetrievalIntegrity = {
  measured: boolean;
  config: RetrievalConfigSummary | null;
  rerankMsTotal: number | null;
  runtimeConfig: RuntimeConfig | null;
  source: string;
};

export type RunIntegrityView = {
  nodes: DecisionNodeCoverageRow[];
  /** Nodes whose status is `unmeasured` — the gaps, listed once so callers never recompute. */
  unmeasuredNodeIds: DecisionNodeId[];
  confidences: ConfidenceObservation[];
  confidenceByProvenance: ConfidenceProvenanceGroup[];
  similarity: SimilarityIntegrity;
  retrieval: RetrievalIntegrity;
  /** True when `final_output` carries none of the B0-490..494 blocks at all. */
  predatesIntegrityInstrumentation: boolean;
};

/* -------------------------------------------------------------------------- *
 * Readers
 * -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readProvenance(
  record: Record<string, unknown> | null,
  key: string,
): ConfidenceProvenance | null {
  const value = record?.[key];
  return typeof value === 'string' && (CONFIDENCE_PROVENANCES as readonly string[]).includes(value)
    ? (value as ConfidenceProvenance)
    : null;
}

/** The minimum a `workflow_steps` row needs to expose for this module — `WorkflowStepRow` satisfies it. */
export type IntegrityStepRow = { step_name: string; output: unknown };

export type BuildRunIntegrityViewInput = {
  /** `workflow_runs.confidence` — the denormalized column, which can disagree with the payload. */
  runConfidence: number | null;
  /** `workflow_runs.final_output`, untyped `Json`. */
  finalOutput: unknown;
  steps: readonly IntegrityStepRow[];
};

export function buildRunIntegrityView(input: BuildRunIntegrityViewInput): RunIntegrityView {
  const finalOutput = asRecord(input.finalOutput);

  const gateRecordsByGateId = new Map<GateId, GateRecord[]>();
  for (const step of input.steps) {
    for (const record of readStepGateRecords(step.output)) {
      const bucket = gateRecordsByGateId.get(record.gate);
      if (bucket) {
        bucket.push(record);
      } else {
        gateRecordsByGateId.set(record.gate, [record]);
      }
    }
  }

  const activeGatesParsed = activeGatesSchema.safeParse(finalOutput?.activeGates);
  const runtimeConfigParsed = runtimeConfigSchema.safeParse(finalOutput?.runtimeConfig);
  const similarityParsed = similaritySummarySchema.safeParse(finalOutput?.similaritySummary);
  const retrievalParsed = retrievalConfigSummarySchema.safeParse(finalOutput?.retrievalConfig);

  const activeGates = activeGatesParsed.success ? activeGatesParsed.data : null;
  const runtimeConfig = runtimeConfigParsed.success ? runtimeConfigParsed.data : null;

  const ctx: NodeContext = {
    finalOutput,
    gateRecordsByGateId,
    activeGates,
    runtimeConfig,
    stepNames: new Set(input.steps.map((step) => step.step_name)),
    isDeclineRun: readString(finalOutput, 'answerProvenance') === 'decline_gate',
  };

  const nodes: DecisionNodeCoverageRow[] = DECISION_NODES.map((node) => {
    const { resolve, ...definition } = node;
    return {
      ...definition,
      ...resolve(ctx),
      records: node.gateIds.flatMap((id) => gateRecordsByGateId.get(id) ?? []),
      activation: node.activationKey ? (activeGates?.[node.activationKey] ?? null) : null,
    };
  });

  const confidences = collectConfidenceObservations({
    runConfidence: input.runConfidence,
    finalOutput,
    steps: input.steps,
  });

  return {
    nodes,
    unmeasuredNodeIds: nodes.filter((n) => n.status === 'unmeasured').map((n) => n.id),
    confidences,
    confidenceByProvenance: groupConfidencesByProvenance(confidences),
    similarity: buildSimilarityIntegrity(
      similarityParsed.success ? similarityParsed.data : null,
      ctx.isDeclineRun,
    ),
    retrieval: {
      measured: retrievalParsed.success && hasKey(finalOutput, 'retrievalConfig'),
      config: retrievalParsed.success ? retrievalParsed.data : null,
      rerankMsTotal: readNumber(finalOutput, 'rerankMsTotal'),
      runtimeConfig,
      source: 'final_output.retrievalConfig (B0-493) + rerankMsTotal (B0-619)',
    },
    predatesIntegrityInstrumentation:
      !hasKey(finalOutput, 'similaritySummary') &&
      !hasKey(finalOutput, 'retrievalConfig') &&
      !hasKey(finalOutput, 'runtimeConfig') &&
      !hasKey(finalOutput, 'confidenceProvenance'),
  };
}

function buildSimilarityIntegrity(
  summary: SimilaritySummary | null,
  isDeclineRun: boolean,
): SimilarityIntegrity {
  if (!summary) {
    return {
      measured: false,
      rawTopSimilarity: null,
      selectedTopSimilarity: null,
      droppedByFilterCount: null,
      source: 'final_output.similaritySummary (B0-490)',
      note: isDeclineRun
        ? 'The early-decline gate answered this run, so no retrieval happened to measure.'
        : 'Unmeasured — this run predates B0-490, so raw and post-filter similarity cannot be told apart.',
    };
  }
  return {
    measured: true,
    rawTopSimilarity: summary.rawTopSimilarity,
    selectedTopSimilarity: summary.selectedTopSimilarity,
    droppedByFilterCount: summary.droppedByFilterCount,
    source: 'final_output.similaritySummary (B0-490)',
    note:
      summary.rawTopSimilarity === null && summary.selectedTopSimilarity === null
        ? 'Recorded, but all-null: no search-backed tool call carried a retrieval block on this turn.'
        : 'Raw is the pre-curation ANN top hit; selected is the best of what survived selectCuratedMatches.',
  };
}

function collectConfidenceObservations(input: {
  runConfidence: number | null;
  finalOutput: Record<string, unknown> | null;
  steps: readonly IntegrityStepRow[];
}): ConfidenceObservation[] {
  const { finalOutput } = input;
  const runProvenance = resolveConfidenceProvenance(
    readProvenance(finalOutput, 'confidenceProvenance'),
  );
  const preCapValue = readNumber(finalOutput, 'confidencePreCapValue');
  const preCapProvenance = readProvenance(finalOutput, 'confidencePreCapProvenance');

  const observations: ConfidenceObservation[] = [
    {
      id: 'run_row_confidence',
      label: 'Run row confidence',
      value: input.runConfidence,
      provenance: runProvenance,
      isJudgment: isJudgmentProvenance(runProvenance),
      preCapValue,
      preCapProvenance,
      source: 'workflow_runs.confidence',
      note: 'The denormalized column the dashboards aggregate; provenance is only ever recorded on the payload beside it.',
    },
    {
      id: 'final_output_confidence',
      label: 'Final output confidence',
      value: readNumber(finalOutput, 'confidence'),
      provenance: runProvenance,
      isJudgment: isJudgmentProvenance(runProvenance),
      preCapValue,
      preCapProvenance,
      source: 'final_output.confidence',
      note: null,
    },
  ];

  const validation = asRecord(finalOutput?.validation);
  if (validation) {
    observations.push({
      id: 'validation_confidence',
      label: 'Validator verdict confidence',
      value: readNumber(validation, 'confidence'),
      provenance: runProvenance,
      isJudgment: isJudgmentProvenance(runProvenance),
      preCapValue,
      preCapProvenance,
      source: 'final_output.validation.confidence',
      note: 'The post-gate validator verdict; the gates mutate this in place, so it is the same number as above unless a write went wrong.',
    });
  }

  const agentReason = readString(finalOutput, 'agentConfidenceReason');
  if (agentReason || finalOutput?.agentConfidence !== undefined) {
    observations.push({
      id: 'agent_self_confidence',
      label: 'Agent self-score',
      value: readNumber(finalOutput, 'agentConfidence'),
      provenance: 'agent_self_scored',
      isJudgment: isJudgmentProvenance('agent_self_scored'),
      preCapValue: null,
      preCapProvenance: null,
      source: 'final_output.agentConfidence',
      note: agentReason
        ? `reason: ${agentReason}${
            readString(finalOutput, 'agentConfidenceBasis')
              ? ` — ${readString(finalOutput, 'agentConfidenceBasis')}`
              : ''
          }`
        : 'No `agentConfidenceReason` recorded (pre-B0-491), so a null score is unexplained.',
    });
  }

  // B0-492 also stamps provenance on the validator STEP row, which is a distinct measurement
  // point from the run-level one — a disagreement between them is itself an integrity signal.
  for (const step of input.steps) {
    if (step.step_name !== 'validator') {
      continue;
    }
    const output = asRecord(step.output);
    const stepProvenance = resolveConfidenceProvenance(
      readProvenance(output, 'confidenceProvenance'),
    );
    observations.push({
      id: 'validator_step_confidence',
      label: 'Validator step confidence',
      value: readNumber(output, 'confidence'),
      provenance: stepProvenance,
      isJudgment: isJudgmentProvenance(stepProvenance),
      preCapValue: readNumber(output, 'confidencePreCapValue'),
      preCapProvenance: readProvenance(output, 'confidencePreCapProvenance'),
      source: 'workflow_steps[validator].output.confidence',
      note: readString(output, 'reason')
        ? `step reason: ${readString(output, 'reason')}`
        : null,
    });
  }

  return observations;
}

/**
 * B0-492 — the aggregate view. A single mean across every confidence on a run would average a
 * regex-shaped constant with a model judgment, which is the defect this replaces: values are
 * grouped by the mechanism that produced them, and a mean is only ever computed WITHIN a group.
 */
export function groupConfidencesByProvenance(
  observations: readonly ConfidenceObservation[],
): ConfidenceProvenanceGroup[] {
  const byProvenance = new Map<ConfidenceProvenance, number[]>();
  for (const observation of observations) {
    if (observation.value === null) {
      continue;
    }
    const bucket = byProvenance.get(observation.provenance);
    if (bucket) {
      bucket.push(observation.value);
    } else {
      byProvenance.set(observation.provenance, [observation.value]);
    }
  }

  return CONFIDENCE_PROVENANCES.filter((provenance) => byProvenance.has(provenance)).map(
    (provenance) => {
      const values = byProvenance.get(provenance) ?? [];
      return {
        provenance,
        isJudgment: isJudgmentProvenance(provenance),
        count: values.length,
        values,
        min: Math.min(...values),
        max: Math.max(...values),
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      };
    },
  );
}

/* -------------------------------------------------------------------------- *
 * Coverage assertion
 * -------------------------------------------------------------------------- */

export type CoverageGapKind = 'unregistered_gate' | 'unregistered_activation' | 'unmeasured_node';

export type CoverageGap = {
  kind: CoverageGapKind;
  /** The gate id, activation key or decision-node id that is not covered. */
  id: string;
  message: string;
};

/**
 * The single coverage check, in three parts:
 *
 * 1. every `gateIdSchema` value is owned by exactly one node in `DECISION_NODES`;
 * 2. every `activeGatesSchema` key is owned by one node;
 * 3. every node that a given run EXECUTED emitted a record.
 *
 * (1) and (2) are what fail the build when a decision node is added without instrumentation: a new
 * gate id with no registry entry has nothing rendering it, and this names it. (3) is what the panel
 * renders as an explicit "unmeasured" row.
 */
export function findDecisionNodeCoverageGaps(input: {
  gateIds?: readonly string[];
  activationKeys?: readonly string[];
  view?: RunIntegrityView | null;
}): CoverageGap[] {
  const gaps: CoverageGap[] = [];

  const registeredGateIds = new Set<string>(DECISION_NODES.flatMap((node) => [...node.gateIds]));
  for (const gateId of input.gateIds ?? []) {
    if (!registeredGateIds.has(gateId)) {
      gaps.push({
        kind: 'unregistered_gate',
        id: gateId,
        message: `Decision node "${gateId}" can change a run's outcome but no entry in DECISION_NODES claims it, so nothing measures or renders it. Add it to \`src/lib/observability/integrity-coverage.ts\`.`,
      });
    }
  }

  const registeredActivationKeys = new Set<string>(
    DECISION_NODES.map((node) => node.activationKey).filter(
      (key): key is keyof ActiveGates => key !== null,
    ),
  );
  for (const key of input.activationKeys ?? []) {
    if (!registeredActivationKeys.has(key)) {
      gaps.push({
        kind: 'unregistered_activation',
        id: key,
        message: `Gate activation "${key}" is tracked on final_output.activeGates but no entry in DECISION_NODES claims it, so its ran/skipped/bypassed state is never surfaced. Add it to \`src/lib/observability/integrity-coverage.ts\`.`,
      });
    }
  }

  for (const node of input.view?.nodes ?? []) {
    if (node.status === 'unmeasured') {
      gaps.push({
        kind: 'unmeasured_node',
        id: node.id,
        message: `Decision node "${node.id}" (${node.label}) executed on this run but emitted no record: ${node.detail}`,
      });
    }
  }

  return gaps;
}

/** One multi-line message naming every gap, for a test failure or the panel's gap banner. */
export function formatCoverageGaps(gaps: readonly CoverageGap[]): string {
  if (gaps.length === 0) {
    return 'Every decision node is measured.';
  }
  return [
    `${gaps.length} unmeasured decision node${gaps.length === 1 ? '' : 's'}:`,
    ...gaps.map((gap) => `  - [${gap.kind}] ${gap.message}`),
  ].join('\n');
}

/** The enum values the coverage test checks the registry against; exported so both agree. */
export const INSTRUMENTED_GATE_IDS: readonly string[] = gateIdSchema.options;
export const INSTRUMENTED_ACTIVATION_KEYS: readonly string[] = Object.keys(
  activeGatesSchema.shape,
);
