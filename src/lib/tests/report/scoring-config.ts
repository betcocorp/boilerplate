/**
 * B0-812 / B0-813 — the scoring model's one configurable number, and the stricter line every
 * report measures itself against.
 *
 * The Result is binary and derived from the weighted score alone: Pass at `passMark` or above,
 * Fail below. Nothing else moves a Result — no concept gate, no floor, no ceiling, no automatic
 * Pass (Tom Bird, 2026-09-03: "No capping period, just pure numbers and calculations"). A missing
 * must-have concept is *reported* on the case; it lowers Completeness through coverage like any
 * other expected concept and cannot by itself fail a case.
 *
 * `STRICT_PASS_MARK` is not a second gate. It is the line the reference methodology used to fail D
 * grades on, and every report lists the cases that pass only under the current mark — the exact
 * population that would flip to Fail the day the mark is raised — so the cost of tightening is
 * visible before anyone tightens.
 */

/** Settings row, per B0-638 (never an env var). */
export const PASS_MARK_SETTING_KEY = 'REPORT_PASS_MARK';

/** Pass at 60 or above: A/B/C/D pass, only an F fails. */
export const DEFAULT_PASS_MARK = 60;

/** The stricter line reports measure against (D would fail). Reported, never applied. */
export const STRICT_PASS_MARK = 70;

/** A pass mark is a 0–100 score; anything else falls back to the shipped default. */
export function clampPassMark(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PASS_MARK;
  return Math.min(100, Math.max(0, value));
}

/**
 * The only async function in this module, and the only place the setting is read — mirroring
 * `loadConsistencyConfig`. Imported lazily because `settings-service` reaches the Supabase
 * service-role client and this module's constants are read by client components.
 */
export async function loadPassMark(): Promise<number> {
  const { getNumberSetting } = await import('~/lib/settings/settings-service');
  return clampPassMark(await getNumberSetting(PASS_MARK_SETTING_KEY, DEFAULT_PASS_MARK));
}
