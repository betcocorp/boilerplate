'use client';

import { Search, SlidersHorizontal } from 'lucide-react';

import { RagQueryAutocomplete } from '~/components/admin/RagQueryAutocomplete';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';

import type { RagSearchSettingsValues } from '~/components/admin/rag/RagSearchControls';

const SCOPE_CHIP_LABELS: Record<string, string> = {
  all: 'All',
  label: 'Labels',
  efficacy: 'Efficacy',
  sds: 'SDS',
  products: 'Products',
  knowledge: 'Knowledge',
};

type QueryOption = {
  query: string;
  queryCount: number;
};

type RagSearchToolbarProps = {
  changedCount: number;
  onOpenDrawer: () => void;
  popularQueries: QueryOption[];
  query: string;
  settings: RagSearchSettingsValues;
};

/**
 * B0-621 — query input + Search + "Retrieval settings" drawer trigger, plus a chip row that
 * summarizes the *currently selected* (not-yet-submitted) drawer settings. `RagQueryAutocomplete`
 * lives here so it stays inside the same `<form>` as every other field (see
 * `RagSearchControls`) — its own suggestion-select navigation reads `inputRef.current.form`.
 */
export function RagSearchToolbar({
  changedCount,
  onOpenDrawer,
  popularQueries,
  query,
  settings,
}: RagSearchToolbarProps) {
  // B0-1017 — in GUID mode the box holds a record id, so popular-query suggestions are noise.
  const isGuidMode = settings.mode === 'guid';

  const chips: Array<{ label: string; value: string }> = [
    {
      label: 'Scope',
      value: SCOPE_CHIP_LABELS[settings.scope] ?? settings.scope,
    },
    {
      label: 'Retrieval',
      value: settings.retrieval === 'vector' ? 'Vector' : 'Hybrid',
    },
    { label: 'Limit', value: settings.limit.trim() || '8' },
    { label: 'Section', value: settings.sectionType || 'Any' },
    { label: 'Floor', value: settings.minSimilarity.trim() || 'none' },
    { label: 'Rerank', value: settings.useReranker ? 'forced on' : 'inherit' },
    { label: 'Fan-out', value: settings.useMultiIntent ? 'on' : 'off' },
    {
      label: 'Mode',
      value: isGuidMode
        ? `GUID (${settings.guidTarget === 'document' ? 'documents' : 'chunks'})`
        : 'Semantic',
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <RagQueryAutocomplete
            defaultValue={query}
            name="q"
            options={isGuidMode ? [] : popularQueries}
            placeholder={
              isGuidMode
                ? `Paste a ${settings.guidTarget === 'chunk' ? 'chunk' : 'document'} GUID`
                : 'Ask something like: peroxide bathroom disinfectant'
            }
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button className="h-12 rounded-2xl px-6 font-semibold" type="submit">
            <Search className="size-4" />
            Search
          </Button>
          <Button
            className="h-12 rounded-2xl px-4 font-medium"
            onClick={onOpenDrawer}
            type="button"
            variant="outline"
          >
            <SlidersHorizontal className="size-4" />
            <Badge variant={changedCount > 0 ? 'default' : 'secondary'}>
              {changedCount > 0 ? changedCount : 'default'}
            </Badge>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {chips.map((chip) => (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/50 px-3 py-1 text-xs text-muted-foreground"
            key={chip.label}
          >
            <span className="font-medium text-foreground">{chip.label}:</span>
            {chip.value}
          </span>
        ))}
      </div>
    </div>
  );
}
