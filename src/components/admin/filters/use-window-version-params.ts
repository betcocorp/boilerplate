'use client';

/**
 * B0-629 — the shared window/version searchParams logic behind the admin dashboards' filters.
 *
 * The `/admin` Mission Control filter chips write `?from`/`?to`/`?version`. If that writing ever
 * differed between components, a copied URL would not reproduce the same view.
 *
 * So the writing lives here, exactly once, and each component keeps its own markup and its own
 * preset labels. This hook holds no filter state — the URL is the state — beyond the router
 * transition's pending flag, which is why a pasted URL reproduces the view and browser
 * back/forward works.
 *
 * `from`/`to` are written as `YYYY-MM-DD` EST, which is precisely what
 * `resolveHealthSearchParams` (`~/lib/bex-health/search-params`) reads back. Keep the two in step.
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Shared by both filter surfaces; each supplies its own human labels for these day counts. */
export type WindowVersionOption = { value: string; label: string };

/**
 * The `<option>` value for a URL window that matches no preset. Rendered as a DISABLED echo
 * rather than hidden, so a pasted custom range is visible in the control instead of the select
 * silently misreporting one of the presets.
 */
export const CUSTOM_WINDOW_VALUE = 'custom';

export function useWindowVersionParams({
  windowDays,
  windowEndsToday,
  presetDays,
}: {
  /** Inclusive span of the resolved window, in days. */
  windowDays: number;
  /** True when the window ends on the current EST day — only then can it be a trailing preset. */
  windowEndsToday: boolean;
  /** The day counts this surface offers, e.g. `[1, 7, 14, 30]`. */
  presetDays: readonly number[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // A window that does not end today is never a trailing preset, however many days it spans.
  const matchedPresetDays =
    presetDays.find((days) => windowEndsToday && days === windowDays) ?? null;

  function replaceParams(mutate: (params: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    const query = params.toString();
    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname);
    });
  }

  /** Takes the raw `<select>` value; ignores the disabled "custom" echo. */
  function setWindowDays(value: string) {
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1) {
      return;
    }
    const nowMs = Date.now();
    const to = new Date(nowMs).toISOString().slice(0, 10);
    const from = new Date(nowMs - (days - 1) * DAY_MS).toISOString().slice(0, 10);
    replaceParams((params) => {
      params.set('from', from);
      params.set('to', to);
    });
  }

  function setVersion(value: string) {
    replaceParams((params) => {
      if (value) {
        params.set('version', value);
      } else {
        // Blank means all traffic; clearing the param keeps the URL honest about the default.
        params.delete('version');
      }
    });
  }

  return {
    isPending,
    /** The `<select>` value in force: a preset's day count as a string, or `CUSTOM_WINDOW_VALUE`. */
    windowValue: matchedPresetDays === null ? CUSTOM_WINDOW_VALUE : String(matchedPresetDays),
    /** True when the URL window matches no preset, so the caller renders the disabled echo. */
    isCustomWindow: matchedPresetDays === null,
    setWindowDays,
    setVersion,
  };
}
