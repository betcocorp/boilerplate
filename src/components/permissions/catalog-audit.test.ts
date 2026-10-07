import { describe, expect, it } from 'vitest';

import { summarizePermissionCatalog } from '~/components/permissions/catalog-audit';

describe('summarizePermissionCatalog', () => {
  it('splits the catalog into deployed and missing, and reports coverage', () => {
    const audit = summarizePermissionCatalog(
      ['admin.card.permissions', 'example.resource.use', 'navigation.sidebar.example'],
      ['admin.card.permissions', 'example.resource.use'],
    );

    expect(audit.catalogSelectors).toHaveLength(3);
    expect(audit.deployedSelectors).toEqual([
      'admin.card.permissions',
      'example.resource.use',
    ]);
    expect(audit.missingInDb).toEqual(['navigation.sidebar.example']);
    expect(audit.unusedInCode).toEqual([]);
    expect(audit.coveragePercent).toBe(67);
  });

  it('treats a wildcard row as covering every catalog selector beneath it', () => {
    const audit = summarizePermissionCatalog(
      ['navigation.sidebar.example', 'navigation.sidebar.tests'],
      ['navigation.sidebar.*'],
    );

    expect(audit.missingInDb).toEqual([]);
    expect(audit.unusedInCode).toEqual([]);
    expect(audit.coveragePercent).toBe(100);
  });

  it('never reports `*` as unused, and covers everything with it', () => {
    const audit = summarizePermissionCatalog(['example.resource.use'], ['*']);

    expect(audit.missingInDb).toEqual([]);
    expect(audit.unusedInCode).toEqual([]);
    expect(audit.coveragePercent).toBe(100);
  });

  it('flags a deployed row that no catalog selector checks', () => {
    const audit = summarizePermissionCatalog(
      ['example.resource.use'],
      ['example.resource.use', 'legacy.thing.gone', 'legacy.other.*'],
    );

    expect(audit.unusedInCode).toEqual(['legacy.other.*', 'legacy.thing.gone']);
    expect(audit.missingInDb).toEqual([]);
  });

  it('trims, drops blanks, de-duplicates and sorts both inputs', () => {
    const audit = summarizePermissionCatalog(
      ['  b.two  ', 'a.one', 'a.one', '', '   '],
      [' a.one ', 'a.one'],
    );

    expect(audit.catalogSelectors).toEqual(['a.one', 'b.two']);
    expect(audit.deployedSelectors).toEqual(['a.one']);
    expect(audit.missingInDb).toEqual(['b.two']);
  });

  it('reports full coverage for an empty catalog rather than dividing by zero', () => {
    const audit = summarizePermissionCatalog([], ['a.one']);

    expect(audit.coveragePercent).toBe(100);
    expect(audit.missingInDb).toEqual([]);
    expect(audit.unusedInCode).toEqual(['a.one']);
  });
});
