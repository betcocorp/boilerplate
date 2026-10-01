import { describe, expect, it } from 'vitest';

import { classifyUserIntent } from '~/lib/orchestrator/intent-classifier';
import { classifyUserIntentSemantic } from '~/lib/orchestrator/semantic-router';
import {
  computeSemanticRoutingAccuracy,
  computeThreeWayAgreement,
  type SemanticRoutingItem,
} from '~/lib/tests/routing-comparison';
import {
  evaluateSemanticRoutingGate,
  formatSemanticRoutingGateResult,
} from '~/lib/tests/semantic-routing-gate';
import { ORCHESTRATOR_INTENT_LABELS } from '~/lib/training/orchestrator-intent-labels';

/**
 * B0-652 — the EXECUTION half of the semantic-router eval: runs the B0-499 golden set (74 labeled
 * messages) through the real semantic router and the real LLM classifier, then grades the run with
 * `evaluateSemanticRoutingGate`.
 *
 * This makes REAL OpenAI calls (one embedding + one classification per row), so it is OFF unless
 * `BEX_ROUTING_EVAL_LIVE=true` is set explicitly. `pnpm exec vitest run` therefore stays offline and
 * deterministic; CI opts in from `.github/workflows/eval-gate.yml`, and a developer can opt in with:
 *
 *   BEX_ROUTING_EVAL_LIVE=true OPENAI_API_KEY=… pnpm exec vitest run src/lib/tests/semantic-routing-eval.live.test.ts
 *
 * Lives here (a vitest file) rather than as a `scripts/*.ts` entry point on purpose: the routers are
 * app modules imported via the `~` alias, which the bare `node scripts/…` runner used by
 * `run-eval-gate.ts` cannot resolve. Vitest already resolves the alias, so this is the only way to
 * exercise the routers in-process instead of through a deployed app.
 */
const LIVE = process.env['BEX_ROUTING_EVAL_LIVE'] === 'true';

describe.skipIf(!LIVE)('semantic router golden-set eval (live)', () => {
  it(
    'meets the routing gate over the B0-499 golden set',
    async () => {
      const items: SemanticRoutingItem[] = [];
      const llmRoutes: Array<{ intended: string; llmRoute: string }> = [];
      const agreementRows: Array<{
        keywordRoute: string | null;
        llmRoute: string | null;
        semanticRoute: string | null;
      }> = [];

      // Sequential on purpose: the point is to measure per-call latency, and 74 concurrent
      // embedding calls would measure queueing instead.
      for (const row of ORCHESTRATOR_INTENT_LABELS) {
        const semantic = await classifyUserIntentSemantic(row.message, []);
        const llm = await classifyUserIntent(row.message, []);

        items.push({
          intendedAgentLabel: row.intended_agent,
          plausibleAgentLabels: row.plausible_agents,
          semanticRoute: semantic.route,
          semanticPath: semantic.path,
          semanticRouteLatencyMs: Math.round(semantic.latencyMs),
          semanticEmbeddingMs: Math.round(semantic.embeddingMs),
          semanticScoringMs: Math.round(semantic.scoringMs),
        });
        llmRoutes.push({ intended: row.intended_agent, llmRoute: llm.intent });
        // `keywordRoute: null` on purpose: the AC's comparison is semantic vs LLM classifier vs
        // ground truth, and the keyword router is already captured per-item by run-executor.ts's
        // persisted instrumentation. `computeRoutingAgreement` handles two-of-three present, so
        // this reduces to a genuine LLM/semantic agreement rate rather than a padded three-way one.
        agreementRows.push({
          keywordRoute: null,
          llmRoute: llm.intent,
          semanticRoute: semantic.route,
        });
      }

      // The baseline is the LLM classifier measured over the SAME items in the SAME run — not a
      // historical number that may no longer describe the classifier in this branch.
      const llmMatched = llmRoutes.filter((row) => row.llmRoute === row.intended).length;
      const baselineAccuracy = llmRoutes.length > 0 ? llmMatched / llmRoutes.length : null;

      const result = evaluateSemanticRoutingGate({ items, baselineAccuracy });
      const lenient = computeSemanticRoutingAccuracy(items);
      const agreement = computeThreeWayAgreement(agreementRows);

      console.log(formatSemanticRoutingGateResult(result));
      console.log(
        `  LLM baseline (same run):  ${llmMatched}/${llmRoutes.length}` +
          ` (${baselineAccuracy === null ? 'n/a' : (baselineAccuracy * 100).toFixed(1) + '%'})`,
      );
      console.log(
        `  LLM/semantic agreement:   ${agreement.counts.all_agree}/${agreement.comparableCount}`,
      );

      // An empty or barely-populated measurement must fail rather than skip its way to green.
      expect(lenient.scoredItemCount).toBeGreaterThan(0);
      expect(result.checks.some((check) => check.status === 'pass')).toBe(true);
      expect(result.pass, formatSemanticRoutingGateResult(result)).toBe(true);
    },
    // 74 rows x (embedding + classification), sequential.
    15 * 60_000,
  );
});
