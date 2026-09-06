'use client';

/**
 * B0-629 — the `/admin` Mission Control filter chips: the window preset and the version selector.
 *
 * Presentation only. The searchParams writing lives in `useWindowVersionParams`
 * (`~/components/admin/filters/use-window-version-params`), shared with the health page's
 * `HealthFilters` so the two surfaces cannot drift on what `?from`/`?to`/`?version` mean. This
 * file owns just the chip styling and the preset labels.
 *
 * Option lists arrive as props from the server, so this client bundle imports no data-layer
 * module and no version is ever hardcoded here.
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

/**
 * Trailing inclusive-day presets. Labelled "Today (UTC)" rather than the mockup's "Last 24 hours"
 * because the window this writes is a whole UTC day (`from === to`), not a rolling 24 hours — the
 * label has to describe what the query actually does.
 *
 * `/admin` opens on the same 7-day default as `/admin/bex/health` (see `resolveHealthSearchParams`):
 * golden-set sweeps are started by hand from /admin/tests rather than nightly, so a one-day landing
 * window would leave the health bar's gate verdict empty on most days.
 */
const WINDOW_PRESETS = [
  { value: '1', label: 'Today (UTC)' },
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
] as const;

const PRESET_DAYS = WINDOW_PRESETS.map((preset) => Number(preset.value));

/** Compact bordered chip, not a full form control — but still a real, labelled select. */
const CHIP_CLASS =
  'h-auto w-auto rounded-lg border-border bg-card px-3 py-2 text-xs text-foreground';

export type DashboardVersionOption = WindowVersionOption;

export function DashboardFilters({
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
  versionOptions: DashboardVersionOption[];
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
        'flex flex-wrap items-center gap-2 transition-opacity',
        isPending ? 'opacity-60' : '',
      ].join(' ')}
    >
      <Label className="sr-only" htmlFor="admin-dashboard-window">
        Window
      </Label>
      <Select onValueChange={setWindowDays} value={windowValue}>
        <SelectTrigger className={CHIP_CLASS} id="admin-dashboard-window">
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

      <Label className="sr-only" htmlFor="admin-dashboard-version">
        Version
      </Label>
      <FormSelectField
        className={CHIP_CLASS}
        id="admin-dashboard-version"
        onValueChange={setVersion}
        options={versionOptions.map((option) => ({
          value: option.value,
          label: option.label,
        }))}
        value={selectedVersion}
      />
    </div>
  );
}
