'use client';

import { X } from 'lucide-react';

import { FormSelectField } from '~/components/admin/FormSelectField';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';

import type { RagSearchSettingsValues } from '~/components/admin/rag/RagSearchControls';

type RagSearchSettingsDrawerProps = {
  onApply: () => void;
  onChange: (patch: Partial<RagSearchSettingsValues>) => void;
  onClose: () => void;
  onReset: () => void;
  open: boolean;
  sectionTypeOptions: string[];
  settings: RagSearchSettingsValues;
};

/**
 * B0-621 — fixed-position slide-in panel, deliberately NOT a portal (no `ui/sheet.tsx` /
 * `ui/drawer.tsx`, both of which render via a Radix `Portal` to `document.body`): every field here
 * must stay inside the page's single `<form>` DOM tree so `new FormData(formRef.current)` in
 * `RagSearchControls` captures it. The panel stays mounted (just translated off-screen) while
 * closed so its values persist across drawer toggles.
 *
 * Scope intentionally omits `products`/`knowledge` (out of scope for this tool per B0-621) and
 * Retrieval intentionally omits a "Keyword only" mode — `searchProductChunks` has no such path.
 */
export function RagSearchSettingsDrawer({
  onApply,
  onChange,
  onClose,
  onReset,
  open,
  sectionTypeOptions,
  settings,
}: RagSearchSettingsDrawerProps) {
  return (
    <>
      <div
        aria-hidden
        className={`fixed inset-0 z-40 bg-foreground/30 transition-opacity duration-200 ${
          open
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0'
        }`}
        onClick={onClose}
      />
      <aside
        aria-hidden={!open}
        aria-label="Retrieval settings"
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col gap-5 overflow-y-auto border-l border-border/60 bg-background p-6 shadow-xl transition-transform duration-200 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border/60 pb-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              Retrieval settings
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Adjust filters, then apply to re-run the search.
            </p>
          </div>
          <Button
            onClick={onClose}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </Button>
        </div>

        <div className="flex flex-col gap-6 max-h-full overflow-y-auto">
          <div className="flex flex-col gap-2">
            <Label>Scope</Label>
            <Select
              name="scope"
              onValueChange={(value) => onChange({ scope: value })}
              value={settings.scope}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="label">Labels</SelectItem>
                <SelectItem value="efficacy">Efficacy</SelectItem>
                <SelectItem value="sds">SDS</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Retrieval</Label>
            <Select
              name="retrieval"
              onValueChange={(value) =>
                onChange({
                  retrieval: value === 'vector' ? 'vector' : 'hybrid',
                })
              }
              value={settings.retrieval}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hybrid">
                  Hybrid (vector + keyword)
                </SelectItem>
                <SelectItem value="vector">Vector only</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Limit</Label>
            <Input
              max={20}
              min={1}
              name="limit"
              onChange={(event) => onChange({ limit: event.target.value })}
              type="number"
              value={settings.limit}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label>Similarity threshold</Label>
            <Input
              name="minSimilarity"
              onChange={(event) =>
                onChange({ minSimilarity: event.target.value })
              }
              placeholder="0.65 or 65"
              type="text"
              value={settings.minSimilarity}
            />
            <p className="text-xs text-muted-foreground">
              Optional. A decimal like 0.65 or a whole percent like 65.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Section type</Label>
            <FormSelectField
              className="w-full"
              name="sectionType"
              onValueChange={(value) => onChange({ sectionType: value })}
              options={[
                { value: '', label: 'Any' },
                ...sectionTypeOptions.map((option) => ({
                  value: option,
                  label: option,
                })),
              ]}
              value={settings.sectionType}
            />
          </div>

          {/*
            B0-1017 — Radix renders a form-participating hidden checkbox for a named Switch, so this
            emits `mode=guid` only when on and nothing when off — the same "absent = default"
            semantics `parseExplicitTrue` relies on for the other toggles.
          */}
          <div className="flex items-start gap-3 rounded-2xl border border-border/60 p-3">
            <input
              checked={settings.mode === 'guid'}
              className="mt-0.5 size-4 shrink-0"
              name="mode"
              onChange={(event) =>
                onChange({ mode: event.target.checked ? 'guid' : 'semantic' })
              }
              type="checkbox"
              value="true"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium leading-none text-foreground">
                Strict GUID lookup
              </span>
              <span className="text-xs text-muted-foreground">
                Off runs a normal semantic RAG search; on reads the search box
                as a rag.document_chunk.id / rag.document.id and ignores every
                other retrieval filter.
              </span>
            </span>
          </div>

          {/* B0-1017 — only meaningful while the GUID switch is on, so it is not rendered otherwise. */}
          {settings.mode === 'guid' ? (
            <div className="flex flex-col gap-2">
              <Label>ID targets</Label>
              <Select
                name="guidTarget"
                onValueChange={(value) =>
                  onChange({
                    guidTarget: value === 'document' ? 'document' : 'chunk',
                  })
                }
                value={settings.guidTarget}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="chunk">
                    Chunks (rag.document_chunk.id)
                  </SelectItem>
                  <SelectItem value="document">
                    Documents (rag.document.id)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <Label>Product line key</Label>
            <Input
              name="productLineKey"
              onChange={(event) =>
                onChange({ productLineKey: event.target.value })
              }
              placeholder="Optional product line key"
              type="text"
              value={settings.productLineKey}
            />
            <p className="text-xs text-muted-foreground">
              Filters target product line keys only.
            </p>
          </div>

          <label className="flex cursor-pointer items-start gap-2 rounded-2xl border border-border/60 p-3">
            <input
              checked={settings.useReranker}
              className="mt-0.5 size-4 shrink-0"
              name="useReranker"
              onChange={(event) =>
                onChange({ useReranker: event.target.checked })
              }
              type="checkbox"
              value="true"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium leading-none text-foreground">
                Reranker
              </span>
              <span className="text-xs text-muted-foreground">
                Re-scores results with a cross-encoder after retrieval (requires
                COHERE_API_KEY). Unchecked still inherits the ENABLE_RERANKER
                setting.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2 rounded-2xl border border-border/60 p-3">
            <input
              checked={settings.useMultiIntent}
              className="mt-0.5 size-4 shrink-0"
              name="useMultiIntent"
              onChange={(event) =>
                onChange({ useMultiIntent: event.target.checked })
              }
              type="checkbox"
              value="true"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium leading-none text-foreground">
                Multi-intent fan-out
              </span>
              <span className="text-xs text-muted-foreground">
                Decomposes multi-part queries into sub-queries, searches each in
                parallel, and merges results.
              </span>
            </span>
          </label>
        </div>

        <div className="mt-auto flex items-center justify-end gap-2 border-t border-border/60 pt-4">
          <Button onClick={onReset} type="button" variant="outline">
            Reset
          </Button>
          <Button onClick={onApply} type="submit">
            Apply and re-run
          </Button>
        </div>
      </aside>
    </>
  );
}
