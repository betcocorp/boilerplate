/**
 * B0-922 — every JSON Schema handed to `~/lib/llm/structured-completion`, in one list.
 *
 * B0-910 shipped a nullable enum spelled `{ type: ['string', 'null'], enum: [...] }` in seven
 * properties: OpenAI's structured-output validator accepts it, Anthropic's 400s on it, and the
 * router degraded silently to keyword fallback for a whole eval run. The guard written to catch that
 * (`json-schema.test.ts`) only walked the two schemas that happened to break, so the same mistake in
 * any other schema on the seam would ship exactly as quietly.
 *
 * This registry is what the guard walks instead, so the check covers the *class* of bug at every
 * call site. **Adding a call site means adding its schema here** — that is the only maintenance this
 * file asks for. Entry `name` is the `schemaName` the call site sends, so a guard failure names the
 * call that would 400.
 *
 * Schemas built per call (the category classifier enumerates the live taxonomy) are registered with
 * a representative argument: the shape is fixed by the builder, only the enum members vary.
 */
import { ITEM_SUGGESTIONS_JSON_SCHEMA } from '~/lib/ai-suggestions/item-suggestions-schema';
import { buildClassifierJsonSchema } from '~/lib/category/classifier-prompt';
import { PROMPT_INSIGHTS_JSON_SCHEMA } from '~/lib/observability/prompt-insights';
import { INTENT_CLASSIFICATION_JSON_SCHEMA } from '~/lib/orchestrator/intent-classifier';
import { SIGNALS_JSON_SCHEMA } from '~/lib/orchestrator/signals/analyze-turn-signals';
import { COMPETITOR_EXTRACT_JSON_SCHEMA } from '~/lib/recommendations/extract-competitor-product';
import { GRADER_JSON_SCHEMA as CRITERIA_GRADER_JSON_SCHEMA } from '~/lib/tests/criteria-schemas';
import { DECLINE_GRADER_JSON_SCHEMA } from '~/lib/tests/decline-schemas';
import { ROOT_CAUSE_JSON_SCHEMA } from '~/lib/tests/failure-root-cause';
import {
  GRADER_JSON_SCHEMA as CASE_SCORE_JSON_SCHEMA,
} from '~/lib/tests/report/case-scorer';
import { DIGEST_JSON_SCHEMA, SYNTHESIS_JSON_SCHEMA } from '~/lib/tests/report/synthesizer';
import { RUN_COMPARISON_ANALYSIS_JSON_SCHEMA } from '~/lib/tests/run-comparison-analysis';
import { RUN_INSIGHTS_JSON_SCHEMA } from '~/lib/tests/run-insights';
import { ENRICH_JSON_SCHEMA } from '~/lib/websearch/enrich-competitor-spec';
import { VALIDATION_JSON_SCHEMA } from '~/lib/workflows/product-support/validator';

export type SeamJsonSchema = {
  /** The `schemaName` the call site passes to the seam. */
  name: string;
  /** Where the call is made, so a guard failure points at the code that would 400. */
  callSite: string;
  schema: Record<string, unknown>;
};

export const SEAM_JSON_SCHEMAS: readonly SeamJsonSchema[] = [
  {
    name: 'intent_classification',
    callSite: 'src/lib/orchestrator/intent-classifier.ts',
    schema: INTENT_CLASSIFICATION_JSON_SCHEMA,
  },
  {
    name: 'turn_signals',
    callSite: 'src/lib/orchestrator/signals/analyze-turn-signals.ts',
    schema: SIGNALS_JSON_SCHEMA,
  },
  {
    name: 'category_classification',
    callSite: 'src/lib/category/product-classifier.ts',
    // Built per call from the live taxonomy; the keys here stand in for that option set.
    schema: buildClassifierJsonSchema(['floor_care', 'restroom_care']),
  },
  {
    name: 'validation_result',
    callSite: 'src/lib/workflows/product-support/validator.ts',
    schema: VALIDATION_JSON_SCHEMA,
  },
  {
    name: 'competitor_extract',
    callSite: 'src/lib/recommendations/extract-competitor-product.ts',
    schema: COMPETITOR_EXTRACT_JSON_SCHEMA,
  },
  {
    name: 'competitor_spec_fill',
    callSite: 'src/lib/websearch/enrich-competitor-spec.ts',
    schema: ENRICH_JSON_SCHEMA,
  },
  {
    name: 'criteria_grading_result',
    callSite: 'src/lib/tests/criteria-grader.ts',
    schema: CRITERIA_GRADER_JSON_SCHEMA,
  },
  {
    name: 'semantic_decline_grading_result',
    callSite: 'src/lib/tests/decline-grader.ts',
    schema: DECLINE_GRADER_JSON_SCHEMA,
  },
  {
    name: 'failure_root_cause',
    callSite: 'src/lib/tests/failure-root-cause.ts',
    schema: ROOT_CAUSE_JSON_SCHEMA,
  },
  {
    name: 'case_score',
    callSite: 'src/lib/tests/report/case-scorer.ts',
    schema: CASE_SCORE_JSON_SCHEMA,
  },
  {
    name: 'batch_digest',
    callSite: 'src/lib/tests/report/synthesizer.ts',
    schema: DIGEST_JSON_SCHEMA,
  },
  {
    name: 'report_synthesis',
    callSite: 'src/lib/tests/report/synthesizer.ts',
    schema: SYNTHESIS_JSON_SCHEMA,
  },
  {
    name: 'run_comparison_analysis',
    callSite: 'src/lib/tests/run-comparison-analysis.ts',
    schema: RUN_COMPARISON_ANALYSIS_JSON_SCHEMA,
  },
  {
    name: 'run_insights',
    callSite: 'src/lib/tests/run-insights.ts',
    schema: RUN_INSIGHTS_JSON_SCHEMA,
  },
  {
    name: 'prompt_insights',
    callSite: 'src/app/api/admin/observability/runs/[runId]/insights/route.ts',
    schema: PROMPT_INSIGHTS_JSON_SCHEMA,
  },
  {
    name: 'item_review_suggestions',
    callSite: 'src/app/(authenticated)/admin/tests/[testId]/items/[itemId]/actions.ts',
    schema: ITEM_SUGGESTIONS_JSON_SCHEMA,
  },
] as const;
