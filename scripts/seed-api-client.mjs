/**
 * One-off seed: create (or reuse) the "Local Dev" API project → app → token
 * used to exercise /api/v1/* auth locally. The full token is printed ONCE —
 * copy it into your REST client (or .env.local as BEX_DEV_API_TOKEN) and send
 * it as `Authorization: Bearer <token>`.
 *
 * Safe to re-run: the project/app are reused by name; each run mints a fresh
 * token so you always get a working one. Only ever touches development-env rows.
 *
 * Usage: node scripts/seed-api-client.mjs
 *
 * NOTE: requires the 20260714150000_api_client_registry migration to be applied.
 */
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// ── Load .env.local ──────────────────────────────────────────────────────────
const envContent = readFileSync(new URL('../.env.local', import.meta.url), 'utf-8');
const env = Object.fromEntries(
  envContent
    .split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    }),
);

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

// ── Token generation (must stay consistent with src/lib/api/api-tokens.ts) ────
// Verification only depends on stored_hash === sha256(fullToken).
const PREFIX_LENGTH = 13;
function generateDevToken() {
  const secret = randomBytes(32).toString('base64url');
  const token = `bex_dev_${secret}`;
  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
  return { token, tokenHash, prefix: token.slice(0, PREFIX_LENGTH) };
}

const PROJECT_NAME = 'Local Dev';
const APP_NAME = 'Local';

async function findOrCreateProject() {
  const { data: existing, error: findErr } = await supabase
    .from('api_project')
    .select('id')
    .eq('name', PROJECT_NAME)
    .maybeSingle();
  if (findErr) throw findErr;
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from('api_project')
    .insert({
      name: PROJECT_NAME,
      description: 'Seeded project for local /api/v1 development.',
      contact_email: 'dev@betco.com',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function findOrCreateApp(projectId) {
  const { data: existing, error: findErr } = await supabase
    .from('api_app')
    .select('id')
    .eq('project_id', projectId)
    .eq('name', APP_NAME)
    .eq('environment', 'development')
    .maybeSingle();
  if (findErr) throw findErr;
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from('api_app')
    .insert({ project_id: projectId, name: APP_NAME, environment: 'development' })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function main() {
  const projectId = await findOrCreateProject();
  const appId = await findOrCreateApp(projectId);

  const { token, tokenHash, prefix } = generateDevToken();
  const { error } = await supabase.from('api_key').insert({
    app_id: appId,
    label: `seed ${new Date().toISOString().slice(0, 10)}`,
    token_hash: tokenHash,
    prefix,
  });
  if (error) throw error;

  console.log('\n✅ Seeded Local Dev API token (development environment).\n');
  console.log('   Send it as:  Authorization: Bearer <token>\n');
  console.log('   Token (shown once):\n');
  console.log(`   ${token}\n`);
  console.log('   Optionally add to .env.local for local scripts:');
  console.log(`   BEX_DEV_API_TOKEN=${token}\n`);
}

main().catch((err) => {
  console.error('Seed failed:', err.message ?? err);
  process.exit(1);
});
