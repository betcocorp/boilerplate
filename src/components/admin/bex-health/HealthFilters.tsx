'use client';

/**
 * B0-578 — the health page's two header controls: the time-range preset and the version
 * selector. Both live ENTIRELY in searchParams (`?from=/?to=/?version=`) — this component
 * holds no filter state of its own beyond the router transition's pending flag, so a pasted
 * URL reproduces the exact view and browser navigation works.
 *
 * B0-629 moved that searchParams writing into `useWindowVersionParams`
 * (`~/components/admin/filters/use-window-version-params`), now shared with `/admin` Mission
 * Control's chip variant. The two surfaces look different on purpose; they must not disagree on
 * what the params MEAN, so there is one writer. Rendering here is unchanged.
 *
 * Option lists arrive as props from the server (`HealthHeader` derives them from
 * `listAvailableVersions()` / `hasUnversionedRows()`), so this client bundle imports no
 * data-layer module and no option is ever hardcoded here.
 */

import {
  CUSTOM_WINDOW_VALUE,
  useWindowVersionParams,
  type WindowVersionOption,
} from '~/components/admin/filters/use-window-version-params';
import { FormSelectField } from '~/components/admin/FormSelectField';
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';

/** Trailing inclusive-day presets; values are the day count as a string. */
const WINDOW_PRESETS = [
  { value: '1', label: 'Today' },
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
] as const;

const PRESET_DAYS = WINDOW_PRESETS.map((preset) => Number(preset.value));

export type HealthVersionOption = WindowVersionOption;

export function HealthFilters({
  windowDays,
  windowEndsToday,
  selectedVersion,
  versionOptions,
}: {
  /** Inclusive span of the resolved window, in days. */
  windowDays: number;
  /** True when the window ends on the current EST day — i.e. it can be a trailing preset. */
  windowEndsToday: boolean;
  /** `''` = all traffic; otherwise the `?version=` value in force. */
  selectedVersion: string;
  /** First entry is "All traffic" (`value: ''`); derived from data, never hardcoded. */
  versionOptions: HealthVersionOption[];
}) {
  const { isPending, windowValue, isCustomWindow, setWindowDays, setVersion } =
    useWindowVersionParams({
      presetDays: PRESET_DAYS,
      windowDays,
      windowEndsToday,
    });

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
        <Select onValueChange={setWindowDays} value={windowValue}>
          <SelectTrigger id="bex-health-window">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOW_PRESETS.map((preset) => (
              <SelectItem key={preset.value} value={preset.value}>
                {preset.label}
              </SelectItem>
            ))}
            {isCustomWindow ? (
              <SelectItem disabled value={CUSTOM_WINDOW_VALUE}>
                Custom ({windowDays}d from URL)
              </SelectItem>
            ) : null}
          </SelectContent>
        </Select>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <Label className="text-xs text-slate-500" htmlFor="bex-health-version">
          Version
        </Label>
        <FormSelectField
          id="bex-health-version"
          onValueChange={setVersion}
          options={versionOptions.map((option) => ({
            value: option.value,
            label: option.label,
          }))}
          value={selectedVersion}
        />
      </div>
    </div>
  );
}
