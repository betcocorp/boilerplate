'use client';

/**
 * B0-578 — the health page's two header controls: the time-range preset and the version
 * selector. Both live ENTIRELY in searchParams (`?from=/?to=/?version=`) — this component
 * holds no filter state of its own beyond the router transition's pending flag, so a pasted
 * URL reproduces the exact view and browser navigation works.
 *
 * Option lists arrive as props from the server (`HealthHeader` derives them from
 * `listAvailableVersions()` / `hasUnversionedRows()`), so this client bundle imports no
 * data-layer module and no option is ever hardcoded here.
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { Label } from '~/components/ui/label';
import { NativeSelect } from '~/components/ui/native-select';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Trailing inclusive-day presets; values are the day count as a string. */
const WINDOW_PRESETS = [
  { value: '1', label: 'Today' },
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
] as const;

export type HealthVersionOption = { value: string; label: string };

export function HealthFilters({
  windowDays,
  windowEndsToday,
  selectedVersion,
  versionOptions,
}: {
  /** Inclusive span of the resolved window, in days. */
  windowDays: number;
  /** True when the window ends on the current UTC day — i.e. it can be a trailing preset. */
  windowEndsToday: boolean;
  /** `''` = all traffic; otherwise the `?version=` value in force. */
  selectedVersion: string;
  /** First entry is "All traffic" (`value: ''`); derived from data, never hardcoded. */
  versionOptions: HealthVersionOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const matchedPreset = WINDOW_PRESETS.find(
    (preset) => windowEndsToday && Number(preset.value) === windowDays,
  );
  const windowValue = matchedPreset ? matchedPreset.value : 'custom';

  function replaceParams(mutate: (params: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    const query = params.toString();
    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname);
    });
  }

  function onWindowChange(value: string) {
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1) return; // the disabled "custom" echo
    const nowMs = Date.now();
    const to = new Date(nowMs).toISOString().slice(0, 10);
    const from = new Date(nowMs - (days - 1) * DAY_MS).toISOString().slice(0, 10);
    replaceParams((params) => {
      params.set('from', from);
      params.set('to', to);
    });
  }

  function onVersionChange(value: string) {
    replaceParams((params) => {
      if (value) {
        params.set('version', value);
      } else {
        params.delete('version');
      }
    });
  }

  return (
    <div
      className={[
        'flex flex-wrap items-end gap-4 transition-opacity',
        isPending ? 'opacity-60' : '',
      ].join(' ')}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label className="text-xs text-slate-500" htmlFor="bex-health-window">
          Window
        </Label>
        <NativeSelect
          id="bex-health-window"
          onChange={(event) => onWindowChange(event.target.value)}
          value={windowValue}
        >
          {WINDOW_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.label}
            </option>
          ))}
          {matchedPreset ? null : (
            <option disabled value="custom">
              Custom ({windowDays}d from URL)
            </option>
          )}
        </NativeSelect>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <Label className="text-xs text-slate-500" htmlFor="bex-health-version">
          Version
        </Label>
        <NativeSelect
          id="bex-health-version"
          onChange={(event) => onVersionChange(event.target.value)}
          value={selectedVersion}
        >
          {versionOptions.map((option) => (
            <option key={option.value || 'all'} value={option.value}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      </div>
    </div>
  );
}
