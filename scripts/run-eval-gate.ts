#!/usr/bin/env node
/**
 * CI eval gate — starts a FRESH golden-set run, waits for it, then checks it against the
 * similarity/confidence floors defined on its test suite.
 *
 * B0-465: this script used to only check a run id handed to it, which in CI came from a static
 * `BEX_GATE_LATEST_RUN_ID` secret — so every PR re-graded the same historical run and could never
 * catch a regression the PR itself introduced. It now creates its own run per invocation.
 *
 * Usage:
 *   node scripts/run-eval-gate.ts                      # fresh run from BEX_GATE_TEST_ID
 *   node scripts/run-eval-gate.ts --test-id <uuid>     # fresh run from an explicit suite
 *   node scripts/run-eval-gate.ts --run-id <uuid>      # grade an EXISTING run, no new run
 *
 * Environment variables:
 *   BEX_GATE_BASE_URL          Base URL of the running app (default: http://localhost:3000)
 *   BEX_GATE_API_TOKEN         `bex_<env>_…` client token (also accepts BEX_GATE_API_KEY)
 *   BEX_GATE_TEST_ID           Golden-set test/suite id to run
 *   BEX_GATE_RUN_ID            Grade this existing run instead of creating one
 *   BEX_GATE_RUN_MODE          'full' (default) | 'search'
 *   BEX_GATE_MODEL_TAG         'preview' (default) | 'gpt-4o' | 'gpt-4.1'
 *   BEX_GATE_TIMEOUT_MS        Overall wait budget for the run (default: 1_800_000 = 30 min)
 *   BEX_GATE_POLL_INTERVAL_MS  Poll cadence (default: 10_000)
 *
 * Exit codes:
 *   0 — gate passed
 *   1 — gate failed, run did not finish in budget, or script error
 */

type CreateRunResponse = {
  ok: boolean;
  runId: string;
  testId: string;
  runMode: string;
  totalItems: number;
  suiteVersion: string;
};

type RunProgressResponse = {
  ok: boolean;
  runId: string;
  status: string;
  completedItems: number;
  totalItems: number;
  progressPercent: number;
  passedItems: number;
  failedItems: number;
};

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
  /** B0-494 — true when any item in this run executed with the B0-452 kill switch on. */
  confidence_gating_disabled_for_any_item: boolean;
};

/** Mirrors `TERMINAL_RUN_STATUSES` in `~/lib/tests/types`. */
const TERMINAL_RUN_STATUSES = ['completed', 'completed_with_failures', 'failed', 'cancelled'];

/** A run that stopped without grading every item must never be read as a pass. */
const COMPLETED_RUN_STATUSES = ['completed', 'completed_with_failures'];

function pct(v: number | null): string {
  return v !== null ? `${(v * 100).toFixed(1)}%` : 'n/a';
}

function gateLabel(ok: boolean | null): string {
  if (ok === null) return 'skip';
  return ok ? 'PASS' : 'FAIL';
}

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = process.argv.slice(2);

  const baseUrl = (process.env['BEX_GATE_BASE_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
  const token = process.env['BEX_GATE_API_TOKEN'] ?? process.env['BEX_GATE_API_KEY'];
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const existingRunId = flag(args, '--run-id') ?? process.env['BEX_GATE_RUN_ID'];
  const testId = flag(args, '--test-id') ?? process.env['BEX_GATE_TEST_ID'];

  if (!existingRunId && !testId) {
    console.error(
      'Error: set BEX_GATE_TEST_ID (to start a fresh run) or pass --run-id <uuid> / set ' +
        'BEX_GATE_RUN_ID (to grade an existing one).',
    );
    process.exit(1);
  }

  const timeoutMs = positiveIntEnv(process.env['BEX_GATE_TIMEOUT_MS'], 1_800_000);
  const pollIntervalMs = positiveIntEnv(process.env['BEX_GATE_POLL_INTERVAL_MS'], 10_000);

  let runId = existingRunId;

  if (runId) {
    console.log(`Grading existing run ${runId} (no new run started).`);
  } else {
    const runMode = process.env['BEX_GATE_RUN_MODE'] === 'search' ? 'search' : 'full';
    const modelTag = process.env['BEX_GATE_MODEL_TAG'] ?? 'preview';

    console.log(`Creating a ${runMode} run for suite ${testId}…`);
    const createResp = await fetch(`${baseUrl}/api/admin/tests/runs`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ testId, runMode, modelTag }),
    });

    if (!createResp.ok) {
      console.error(
        `Could not create a run (${createResp.status}): ${await createResp.text()}`,
      );
      process.exit(1);
    }

    const created = (await createResp.json()) as CreateRunResponse;
    runId = created.runId;
    console.log(
      `Run ${runId} queued — suite ${created.suiteVersion}, ${created.totalItems} item(s).`,
    );

    /**
     * Execution is synchronous in the route (and capped by its own `maxDuration = 300`), so this
     * request may well time out or be cut off while the run keeps going server-side. That is not a
     * failure: the poll loop below is the source of truth for whether the run finished.
     */
    console.log('Starting execution…');
    await fetch(`${baseUrl}/api/admin/tests/runs/${runId}`, { method: 'POST', headers }).catch(
      (err: unknown) => {
        console.log(`  (execute request did not return cleanly: ${String(err)} — still polling)`);
        return undefined;
      },
    );
  }

  // Poll until the run reaches a terminal status or the wait budget runs out.
  const deadline = Date.now() + timeoutMs;
  let status = '';

  while (Date.now() < deadline) {
    const progressResp = await fetch(`${baseUrl}/api/admin/tests/runs/${runId}`, { headers });

    if (!progressResp.ok) {
      console.error(
        `Progress request failed (${progressResp.status}): ${await progressResp.text()}`,
      );
      process.exit(1);
    }

    const progress = (await progressResp.json()) as RunProgressResponse;
    status = progress.status;
    console.log(
      `  ${status} — ${progress.completedItems}/${progress.totalItems} ` +
        `(${progress.progressPercent}%), ${progress.passedItems} passed, ${progress.failedItems} failed`,
    );

    if (TERMINAL_RUN_STATUSES.includes(status)) {
      break;
    }

    await sleep(pollIntervalMs);
  }

  if (!TERMINAL_RUN_STATUSES.includes(status)) {
    console.error(
      `Run ${runId} did not finish within ${Math.round(timeoutMs / 1000)}s (last status: ` +
        `${status || 'unknown'}). Failing the gate rather than passing an unfinished run.`,
    );
    process.exit(1);
  }

  if (!COMPLETED_RUN_STATUSES.includes(status)) {
    console.error(`Run ${runId} ended as "${status}" without grading every item — gate FAILS.`);
    process.exit(1);
  }

  const gateUrl = `${baseUrl}/api/admin/tests/runs/${runId}/gate`;
  console.log('');
  console.log(`Checking gate: ${gateUrl}`);

  const resp = await fetch(gateUrl, { headers });

  if (!resp.ok) {
    console.error(`Gate request failed (${resp.status}): ${await resp.text()}`);
    process.exit(1);
  }

  const data = (await resp.json()) as GateResponse;

  console.log('');
  console.log(`Run id:           ${data.runId}`);
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
    if (data.confidence_gating_disabled_for_any_item) {
      console.log(
        '  ⚠ At least one item in this run executed with BEX_DISABLE_CONFIDENCE_GATING on — the confidence gate is forced to "skip" rather than trust a fictional cap.',
      );
    }
  }
  console.log('');
  console.log(`Gate result: ${data.pass ? '✓ PASS' : '✗ FAIL'}`);

  process.exit(data.pass ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
