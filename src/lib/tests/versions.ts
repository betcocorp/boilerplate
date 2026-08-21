import { assertSupabaseNoError as assertNoError } from '~/lib/utils';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-575 — the version dimension for golden-set tier rollups.
 *
 * `listAvailableVersions()` returns every version the dashboards can select: the distinct
 * `workflow_runs.app_version` values (B0-574 stamps) unioned with the `app_version`s of
 * golden-set harness runs (B0-472 stamps), via the `list_available_app_versions` RPC —
 * DISTINCT is computed in SQL, so no unbounded row scan happens in Node.
 *
 * NULL is never a version: rows with NULL `app_version` are the "unversioned" bucket
 * (pre-stamping history — deliberately not backfilled). Select them via
 * `getGoldenSetTierRollup({ version: null })`; they are never attributed to a real version.
 *
 * The version → run resolution rule lives on `~/lib/tests/golden-set.ts`
 * (`resolveGoldenRunsForVersion`): the most recent completed full-mode run of each golden
 * test at the requested version.
 */
export async function listAvailableVersions(): Promise<string[]> {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase.rpc('list_available_app_versions');
  const versions = (assertNoError(result) ?? []) as string[];
  return [...versions].sort(compareAppVersionsDesc);
}

/**
 * Semver-aware descending sort (newest first): numeric segments compare numerically, and a
 * release (`2.0.0`) sorts ahead of its own pre-releases (`2.0.0-dev.3`), per semver. Falls
 * back to plain string comparison for non-semver values rather than throwing.
 */
export function compareAppVersionsDesc(a: string, b: string): number {
  return -compareAppVersionsAsc(a, b);
}

function compareAppVersionsAsc(a: string, b: string): number {
  const parsedA = parseSemverish(a);
  const parsedB = parseSemverish(b);
  if (!parsedA || !parsedB) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  for (let i = 0; i < 3; i += 1) {
    if (parsedA.core[i] !== parsedB.core[i]) {
      return parsedA.core[i] - parsedB.core[i];
    }
  }

  // Same core: a release outranks any pre-release of it.
  if (parsedA.prerelease === null && parsedB.prerelease === null) return 0;
  if (parsedA.prerelease === null) return 1;
  if (parsedB.prerelease === null) return -1;

  // Both pre-releases: dot-segment comparison, numeric segments numerically.
  const segmentsA = parsedA.prerelease.split('.');
  const segmentsB = parsedB.prerelease.split('.');
  const length = Math.max(segmentsA.length, segmentsB.length);
  for (let i = 0; i < length; i += 1) {
    const segA = segmentsA[i];
    const segB = segmentsB[i];
    if (segA === undefined) return -1; // fewer segments = lower precedence
    if (segB === undefined) return 1;
    const numA = /^\d+$/.test(segA) ? Number(segA) : null;
    const numB = /^\d+$/.test(segB) ? Number(segB) : null;
    if (numA !== null && numB !== null) {
      if (numA !== numB) return numA - numB;
    } else if (numA !== null) {
      return -1; // numeric < alphanumeric per semver
    } else if (numB !== null) {
      return 1;
    } else if (segA !== segB) {
      return segA < segB ? -1 : 1;
    }
  }
  return 0;
}

function parseSemverish(
  value: string,
): { core: [number, number, number]; prerelease: string | null } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null,
  };
}
