import { Info } from 'lucide-react';

import type { PermissionCatalogAudit } from '~/components/permissions/catalog-audit';
import { Card, CardContent } from '~/components/ui/card';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '~/components/ui/tooltip';

/**
 * The five coverage tiles at the top of `/admin/permissions`. Port of the inline stat cards on
 * c360's permissions page; the numbers now come from `summarizePermissionCatalog` (see
 * `catalog-audit.ts` for why the source changed from a filesystem scan to the selector catalog).
 */
export function PermissionCoverageTiles({
  audit,
}: {
  audit: PermissionCatalogAudit;
}) {
  const tiles: {
    hint?: string;
    label: string;
    tone?: 'destructive';
    value: string;
  }[] = [
    {
      hint: 'Selectors declared in the PERMISSIONS catalog — everything the app actually checks.',
      label: 'Code Selectors',
      value: String(audit.catalogSelectors.length),
    },
    {
      label: 'Deployed',
      value: String(audit.deployedSelectors.length),
    },
    {
      label: 'Missing In DB',
      tone: audit.missingInDb.length > 0 ? 'destructive' : undefined,
      value: String(audit.missingInDb.length),
    },
    {
      label: 'Unused In Code',
      value: String(audit.unusedInCode.length),
    },
    {
      hint: 'Percentage of catalog selectors that have a matching row in public.permission.',
      label: 'Coverage',
      value: `${audit.coveragePercent}%`,
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
      {tiles.map((tile) => (
        <Card
          className="rounded-3xl border border-border/60 shadow-none"
          key={tile.label}
        >
          <CardContent className="px-5">
            <p className="flex items-center gap-1 text-xs tracking-wide text-muted-foreground uppercase">
              {tile.label}
              {tile.hint ? (
                <Tooltip>
                  <TooltipTrigger>
                    <Info className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[280px] text-center">
                    {tile.hint}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </p>
            <p
              className={`mt-1 text-3xl font-semibold${
                tile.tone === 'destructive' ? ' text-destructive' : ''
              }`}
            >
              {tile.value}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
