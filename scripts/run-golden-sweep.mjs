/**
 * Manual trigger for the golden test sweep.
 *
 * Usage:
 *   pnpm run:golden-sweep [options]
 *
 * Environment variables:
 *   CRON_SECRET — API token for authentication (format: bex_<base64url-secret>)
 *                 Required. Set in .env.local or pass via CLI.
 *   BASE_URL — Base URL for the API (default: http://localhost:3000)
 *   DRY_RUN — Set to "true" to preview without executing (default: false)
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
 */

import process from 'node:process';

const CRON_SECRET = process.env.CRON_SECRET;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const DRY_RUN = process.env.DRY_RUN === 'true';

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
const payload = DRY_RUN ? { dryRun: true } : {};
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — golden tests run concurrently and can be slow

console.log('🔄 Triggering golden test sweep...');
console.log(`   Endpoint: ${endpoint}`);
console.log(`   Dry run: ${DRY_RUN ? 'yes (preview only)' : 'no (will execute)'}`);
console.log(`   Timeout: ${TIMEOUT_MS / 1000 / 60} minutes`);
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

  console.log(`\n✅ Golden test sweep completed successfully (${elapsed}s)`);
  console.log('');

  // Extract key metrics from response
  if (data.runsCreated !== undefined) {
    console.log('📊 Results:');
    console.log(`   Tests initiated: ${data.runsCreated}`);
    if (data.successful !== undefined) {
      console.log(`   Successful: ${data.successful}`);
    }
    if (data.failed !== undefined) {
      console.log(`   Failed: ${data.failed}`);
    }
    if (data.dryRun) {
      console.log(`   (Dry run — no tests actually executed)`);
    }
  } else {
    console.log('Response:', JSON.stringify(data, null, 2));
  }

  console.log('');
  console.log(`🔍 View all runs at: ${BASE_URL}/admin/scheduled`);
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
