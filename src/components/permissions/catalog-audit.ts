/**
 * Coverage summary shown as the five tiles on `/admin/permissions`: which permission selectors the
 * application actually checks versus which ones exist in `public.permission`.
 *
 * Adapted, not ported. c360's `lib/permissions-audit.ts` derived "selectors used in code" by
 * walking `app/`, `components/` and `lib/` with `fs` at request time and regex-matching quoted
 * strings on any line mentioning "permission". this app does not need that guesswork: every selector it
 * checks is declared in `~/lib/permissions/constants.PERMISSIONS` (B0-405), so the catalog *is* the
 * code-side set. That also means no filesystem reads on a request path, which would not survive a
 * serverless deploy anyway.
 *
 * Lives beside the UI it feeds rather than in `~/lib/permissions/` because it is presentation-only
 * (it answers "what should these five tiles say"), and it is a pure function of its inputs.
 */

/** Wildcard-aware: is `selector` granted by something in `deployed`? */
function isCoveredByDeployed(
  selector: string,
  deployed: ReadonlySet<string>,
): boolean {
  if (deployed.has(selector) || deployed.has('*')) return true;
  const parts = selector.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    if (deployed.has(`${parts.slice(0, i).join('.')}.*`)) return true;
  }
  return false;
}

export type PermissionCatalogAudit = {
  /** Selectors the app checks (the `PERMISSIONS` catalog), sorted. */
  catalogSelectors: string[];
  /** Selectors present in `public.permission`, sorted. */
  deployedSelectors: string[];
  /** Catalog selectors with no matching (or wildcard-covering) DB row. */
  missingInDb: string[];
  /** DB rows nothing in the catalog checks. */
  unusedInCode: string[];
  /** Percentage of catalog selectors that are deployed; 100 when the catalog is empty. */
  coveragePercent: number;
};

export function summarizePermissionCatalog(
  catalogSelectorsInput: readonly string[],
  deployedSelectorsInput: readonly string[],
): PermissionCatalogAudit {
  const normalize = (values: readonly string[]) =>
    [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();

  const catalogSelectors = normalize(catalogSelectorsInput);
  const deployedSelectors = normalize(deployedSelectorsInput);
  const deployedSet = new Set(deployedSelectors);

  const missingInDb = catalogSelectors.filter(
    (selector) => !isCoveredByDeployed(selector, deployedSet),
  );

  const unusedInCode = deployedSelectors.filter((selector) => {
    if (selector === '*') return false;
    if (selector.endsWith('.*')) {
      const prefix = selector.slice(0, -2);
      return !catalogSelectors.some((candidate) =>
        candidate.startsWith(`${prefix}.`),
      );
    }
    return !catalogSelectors.includes(selector);
  });

  const coveragePercent =
    catalogSelectors.length === 0
      ? 100
      : Math.round(
          ((catalogSelectors.length - missingInDb.length) /
            catalogSelectors.length) *
            100,
        );

  return {
    catalogSelectors,
    deployedSelectors,
    missingInDb,
    unusedInCode,
    coveragePercent,
  };
}
