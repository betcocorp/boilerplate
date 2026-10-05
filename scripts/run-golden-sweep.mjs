/**
 * Manual trigger for the golden test sweep.
 *
 * This DISPATCHES a run for every golden test and returns; the runs themselves continue executing
 * server-side, and `/admin/scheduled` fills in as the hourly reconciler closes them out.
 *
 * Usage:
 *   pnpm run:golden-sweep [options]
 *
 * Environment variables:
 *   CRON_SECRET — API token for authentication (format: bex_<base64url-secret>)
 *                 Required. Set in .env.local or pass via CLI.
 *   BASE_URL — Base URL for the API (default: http://localhost:3000)
 *   DRY_RUN — Set to "true" to preview without executing (default: false)
 *   TIMEOUT_SECONDS — How long to wait for the dispatch call to return (default: 900 = 15 minutes)
 *   MODEL_TAG_OVERRIDE — B0-1119: force this `modelTag` on every run in the sweep (e.g. gpt-5.5).
 *                        Validated server-side against the supported tag list; a bad tag is a 400.
 *   ROUTER_TYPE_OVERRIDE — B0-1119: force `routerType` on every run: keyword | semantic | llm
 *   USE_VALIDATOR_OVERRIDE — B0-1119: force `useValidator` on every run: "true" | "false"
 *   (An unset override leaves the API's own defaults in charge, exactly as before.)
 *
 * Examples:
 *   # Run locally with CRON_SECRET from .env.local
 *   pnpm run:golden-sweep
 *
 *   # Run against deployed instance
 *   BASE_URL=https://your-deployment.vercel.app pnpm run:golden-sweep
 *
 *   # Dry run (preview only, don't actually execute tests)
 *   DRY_RUN=true pnpm run:golden-sweep
 *
 *   # Custom timeout (e.g., 30 minutes for very large test sets)
 *   TIMEOUT_SECONDS=1800 pnpm run:golden-sweep
 *
 *   # B0-1117 model re-evaluation: run the whole golden roster once on a candidate model
 *   MODEL_TAG_OVERRIDE=gpt-5.6-terra ROUTER_TYPE_OVERRIDE=llm pnpm run:golden-sweep
 *   MODEL_TAG_OVERRIDE=gpt-5.5 USE_VALIDATOR_OVERRIDE=true DRY_RUN=true pnpm run:golden-sweep
 */

import process from 'node:process';

const CRON_SECRET = process.env.CRON_SECRET;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const DRY_RUN = process.env.DRY_RUN === 'true';
const TIMEOUT_SECONDS = parseInt(process.env.TIMEOUT_SECONDS || '900', 10); // Default 15 minutes

// B0-1119 — per-sweep overrides. Forwarded as-is; the API validates tag/router values and answers
// a 400 with `issues` (printed below) for anything it does not recognise.
const MODEL_TAG_OVERRIDE = process.env.MODEL_TAG_OVERRIDE || undefined;
const ROUTER_TYPE_OVERRIDE = process.env.ROUTER_TYPE_OVERRIDE || undefined;
const USE_VALIDATOR_OVERRIDE_RAW = process.env.USE_VALIDATOR_OVERRIDE;
let USE_VALIDATOR_OVERRIDE;
if (USE_VALIDATOR_OVERRIDE_RAW !== undefined && USE_VALIDATOR_OVERRIDE_RAW !== '') {
  if (USE_VALIDATOR_OVERRIDE_RAW === 'true' || USE_VALIDATOR_OVERRIDE_RAW === 'false') {
    USE_VALIDATOR_OVERRIDE = USE_VALIDATOR_OVERRIDE_RAW === 'true';
  } else {
    console.error(
      `❌ Error: USE_VALIDATOR_OVERRIDE must be "true" or "false" (got "${USE_VALIDATOR_OVERRIDE_RAW}")`,
    );
    process.exit(1);
  }
}

if (!CRON_SECRET) {
  console.error('❌ Error: CRON_SECRET environment variable is not set');
  console.error('');
  console.error('CRON_SECRET must be a valid API token (format: bex_<base64url-secret>)');
  console.error('Set it in .env.local or pass it as an environment variable:');
  console.error('');
  console.error('  CRON_SECRET=bex_... pnpm run:golden-sweep');
  console.error('  # or in .env.local:');
  console.error('  # CRON_SECRET=bex_...');
  process.exit(1);
}

const endpoint = `${BASE_URL}/api/v1/observability/run-golden-test-sweep`;
// Only supplied keys go on the wire, so a plain sweep still sends `{}` (or `{ dryRun: true }`).
const payload = {
  ...(DRY_RUN ? { dryRun: true } : {}),
  ...(MODEL_TAG_OVERRIDE !== undefined ? { modelTagOverride: MODEL_TAG_OVERRIDE } : {}),
  ...(ROUTER_TYPE_OVERRIDE !== undefined ? { routerTypeOverride: ROUTER_TYPE_OVERRIDE } : {}),
  ...(USE_VALIDATOR_OVERRIDE !== undefined ? { useValidatorOverride: USE_VALIDATOR_OVERRIDE } : {}),
};
const TIMEOUT_MS = TIMEOUT_SECONDS * 1000;

/** Renders `{ modelTag, routerType, useValidator }` as a one-line summary, or `null` when empty. */
function describeOverrides(overrides) {
  if (!overrides || typeof overrides !== 'object') return null;
  const parts = Object.entries(overrides)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.length > 0 ? parts.join(', ') : null;
}

const requestedOverrides = describeOverrides({
  modelTag: MODEL_TAG_OVERRIDE,
  routerType: ROUTER_TYPE_OVERRIDE,
  useValidator: USE_VALIDATOR_OVERRIDE,
});

console.log('🔄 Triggering golden test sweep...');
console.log(`   Endpoint: ${endpoint}`);
console.log(`   Dry run: ${DRY_RUN ? 'yes (preview only)' : 'no (will execute)'}`);
console.log(`   Overrides: ${requestedOverrides ?? 'none (API defaults)'}`);
console.log(`   Timeout: ${TIMEOUT_SECONDS} seconds (~${Math.round(TIMEOUT_SECONDS / 60)} minutes)`);
console.log('');
console.log('⏳ Sending request to server...');

const startTime = Date.now();
let progressInterval;

try {
  // Start progress indicator
  let dotCount = 0;
  progressInterval = setInterval(() => {
    dotCount++;
    process.stdout.write('.');
    if (dotCount === 60) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(` (${elapsed}s)`);
      dotCount = 0;
    }
  }, 1000);

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CRON_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });

  clearTimeout(timeoutHandle);
  clearInterval(progressInterval);

  const data = await response.json();
  const elapsed = Math.round((Date.now() - startTime) / 1000);

  if (!response.ok) {
    console.error(`\n❌ Request failed with status ${response.status} (after ${elapsed}s)`);
    console.error('\nResponse:');
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  // Response shape is `{ ok: true, result: RunGoldenTestSweepResult }` — see
  // src/lib/observability/run-golden-test-sweep.ts.
  const result = data?.result;

  if (!result || typeof result !== 'object') {
    console.log(`\n⚠️  Unexpected response shape (after ${elapsed}s):`);
    console.log(JSON.stringify(data, null, 2));
    console.log('');
    console.log(`🔍 View sweeps at: ${BASE_URL}/admin/scheduled`);
    process.exit(0);
  }

  const outcomes = Array.isArray(result.outcomes) ? result.outcomes : [];
  const failedOutcomes = outcomes.filter((outcome) => outcome?.ok === false);

  if (result.dryRun) {
    console.log(`\n✅ Dry run finished — nothing was dispatched (${elapsed}s)`);
  } else {
    console.log(`\n📤 Golden test runs dispatched (${elapsed}s)`);
  }
  console.log('');

  console.log('📊 Dispatch summary:');
  console.log(`   Golden tests found: ${result.goldenTestCount ?? 0}`);
  console.log(`   Dispatched:         ${result.started ?? 0}`);
  console.log(`   Failed to dispatch: ${result.failed ?? 0}`);
  if (result.scheduledRunId) {
    console.log(`   Sweep ledger row:   ${result.scheduledRunId}`);
  }
  const appliedOverrides = describeOverrides(result.overrides);
  if (appliedOverrides) {
    console.log(`   Overrides applied:  ${appliedOverrides}`);
  }

  if (failedOutcomes.length > 0) {
    console.log('');
    console.log('❌ Failed to dispatch:');
    for (const outcome of failedOutcomes) {
      const step = outcome.step ? ` [${outcome.step}]` : '';
      console.log(
        `   • ${outcome.testName ?? outcome.testId ?? 'unknown test'}${step}: ${outcome.error ?? 'unknown error'}`,
      );
    }
  }

  if (!result.dryRun) {
    console.log('');
    console.log('⚠️  Dispatched is NOT finished. This call only starts each golden test;');
    console.log('   the runs keep executing server-side well after this command returns.');
    console.log('   Results appear on /admin/scheduled as the hourly reconciler closes');
    console.log('   each run out, so expect the page to fill in over the next hour or two.');
  }

  console.log('');
  console.log(`🔍 View sweeps at: ${BASE_URL}/admin/scheduled`);
  process.exit(0);
} catch (error) {
  clearInterval(progressInterval);
  const elapsed = Math.round((Date.now() - startTime) / 1000);

  if (error instanceof Error && error.name === 'AbortError') {
    console.error(`\n❌ Request timed out after ${elapsed}s`);
    console.error('');
    console.error('The server took too long to respond. Possible causes:');
    console.error('  • Server is running but slow to respond');
    console.error('  • Network connectivity issue');
    console.error('  • Endpoint may still be processing (check /admin/scheduled in 30s)');
  } else {
    console.error(`\n❌ Error (${elapsed}s):`, error instanceof Error ? error.message : String(error));
    console.error('');
    console.error('Troubleshooting:');
    console.error('  • Ensure the server is running: pnpm dev');
    console.error('  • Verify CRON_SECRET is valid (format: bex_<base64url-secret>)');
    console.error('  • Check that BASE_URL is correct: ' + BASE_URL);
    console.error('  • Check server logs for errors');
  }

  process.exit(1);
}
