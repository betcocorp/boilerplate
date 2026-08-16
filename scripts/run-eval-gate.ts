#!/usr/bin/env tsx
/**
 * CI eval gate — checks whether a completed search run passes the similarity
 * floor defined on its test suite.
 *
 * Usage:
 *   pnpm exec tsx scripts/run-eval-gate.ts --run-id <uuid>
 *
 * Environment variables:
 *   BEX_GATE_RUN_ID      Alternative to --run-id flag
 *   BEX_GATE_BASE_URL    Base URL of the running app (default: http://localhost:3000)
 *   BEX_GATE_API_KEY     Optional Bearer token if the route is auth-gated in CI
 *
 * Exit codes:
 *   0 — gate passed
 *   1 — gate failed or script error
 */

type GateResponse = {
  ok: boolean;
  pass: boolean;
  runId: string;
  testId: string;
  suite_version: string;
  run_mode: string;
  item_count: number;
  avg_similarity: number | null;
  similarity_floor: number;
  similarity_ok: boolean | null;
  avg_confidence: number | null;
  confidence_floor: number;
  confidence_ok: boolean | null;
  /** B0-492 — which population `avg_confidence` was averaged over, and how many items. */
  confidence_population: 'judgment_only' | 'unknown_legacy' | 'none';
  confidence_item_count: number;
};

function pct(v: number | null): string {
  return v !== null ? `${(v * 100).toFixed(1)}%` : 'n/a';
}

function gateLabel(ok: boolean | null): string {
  if (ok === null) return 'skip';
  return ok ? 'PASS' : 'FAIL';
}

async function main() {
  const args = process.argv.slice(2);
  const flagIdx = args.indexOf('--run-id');
  const runId =
    flagIdx !== -1 ? args[flagIdx + 1] : process.env['BEX_GATE_RUN_ID'];

  if (!runId) {
    console.error('Error: provide --run-id <uuid> or set BEX_GATE_RUN_ID');
    process.exit(1);
  }

  const baseUrl = process.env['BEX_GATE_BASE_URL'] ?? 'http://localhost:3000';
  const url = `${baseUrl}/api/admin/tests/runs/${runId}/gate`;
  const apiKey = process.env['BEX_GATE_API_KEY'];

  console.log(`Checking gate: ${url}`);

  const resp = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`Gate request failed (${resp.status}): ${body}`);
    process.exit(1);
  }

  const data = (await resp.json()) as GateResponse;

  console.log('');
  console.log(`Suite version:    ${data.suite_version}`);
  console.log(`Run mode:         ${data.run_mode}`);
  console.log(`Items evaluated:  ${data.item_count}`);
  console.log(
    `Avg similarity:   ${pct(data.avg_similarity)} (floor: ${pct(data.similarity_floor)}) → ${gateLabel(data.similarity_ok)}`,
  );
  if (data.run_mode === 'full') {
    // B0-492 — CI must see WHICH population this average came from, not just the number: a
    // `judgment_only` average excludes decline-gate constants and bypass heuristics; an
    // `unknown_legacy` one is a pre-B0-492 stored value with no such guarantee.
    console.log(
      `Avg confidence:   ${pct(data.avg_confidence)} over ${data.confidence_item_count} item(s) [${data.confidence_population}] (floor: ${pct(data.confidence_floor)}) → ${gateLabel(data.confidence_ok)}`,
    );
  }
  console.log('');
  console.log(`Gate result: ${data.pass ? '✓ PASS' : '✗ FAIL'}`);

  process.exit(data.pass ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
