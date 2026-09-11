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

console.log('🔄 Triggering golden test sweep...');
console.log(`   Endpoint: ${endpoint}`);
console.log(`   Dry run: ${DRY_RUN ? 'yes (preview only)' : 'no (will execute)'}`);
console.log('');

try {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CRON_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(`❌ Request failed with status ${response.status}`);
    console.error('Response:', JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log('✅ Golden test sweep triggered successfully');
  console.log('');
  console.log('Response:', JSON.stringify(data, null, 2));
  console.log('');
  console.log('📊 View results at: /admin/scheduled');
  process.exit(0);
} catch (error) {
  console.error('❌ Error:', error instanceof Error ? error.message : String(error));
  console.error('');
  console.error('Troubleshooting:');
  console.error('  • Ensure the server is running (pnpm dev)');
  console.error('  • Verify CRON_SECRET is valid (format: bex_<base64url-secret>)');
  console.error('  • Check that BASE_URL is correct');
  process.exit(1);
}
