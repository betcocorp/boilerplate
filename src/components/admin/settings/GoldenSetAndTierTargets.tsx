import Link from 'next/link';

import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { getGoldenSetMembership } from '~/lib/tests/golden-set';
import { getTierTargets } from '~/lib/tests/tier-targets';
import { updateTierTargetAction } from '~/app/(authenticated)/admin/tests/actions';

export async function GoldenSetAndTierTargets() {
  const [tierTargets, goldenMembership] = await Promise.all([
    getTierTargets(),
    getGoldenSetMembership(),
  ]);

  return (
    <section
      className="scroll-mt-6 rounded-3xl border border-slate-200 bg-white p-8 shadow-sm"
      data-settings-toc-label="Golden set & tier targets"
      id="settings-golden-set"
    >
      <h2 className="text-lg font-semibold text-slate-900">
        Golden set &amp; tier targets
      </h2>
      <p className="mt-2 text-sm text-slate-600">
        Golden sets ({goldenMembership.goldenTests.length}) gate releases; every prompt
        in a golden set must carry a priority (tier 1&ndash;3). Targets are stored in{' '}
        <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">tier_targets</code>{' '}
        and take effect without a deploy; changes are audited.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {tierTargets.map((target) => (
          <form
            action={updateTierTargetAction}
            className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4"
            key={target.tier}
          >
            <input name="returnPath" type="hidden" value="/admin/settings" />
            <input name="tier" type="hidden" value={target.tier} />
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-900">
                Tier {target.tier}
              </span>
              {target.isGate ? (
                <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-700">
                  Hard gate
                </span>
              ) : (
                <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600">
                  Target only
                </span>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-slate-600" htmlFor={`tier-label-${target.tier}`}>
                Label
              </Label>
              <Input
                defaultValue={target.label}
                id={`tier-label-${target.tier}`}
                name="label"
                type="text"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label
                className="text-xs text-slate-600"
                htmlFor={`tier-target-${target.tier}`}
              >
                Target pass rate (0&ndash;1)
              </Label>
              <Input
                defaultValue={target.targetPassRate}
                id={`tier-target-${target.tier}`}
                max="1"
                min="0"
                name="targetPassRate"
                step="0.01"
                type="number"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                className="h-4 w-4 rounded border-slate-300"
                defaultChecked={target.isGate}
                name="isGate"
                type="checkbox"
              />
              Hard gate (can block)
            </label>
            <Button size="sm" type="submit" variant="outline">
              Save tier {target.tier}
            </Button>
          </form>
        ))}
      </div>

      {goldenMembership.missingPriority.length > 0 ? (
        <div className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <h3 className="text-sm font-semibold text-amber-900">
            Data errors: {goldenMembership.missingPriority.length} golden-set prompt
            {goldenMembership.missingPriority.length === 1 ? '' : 's'} missing a priority
          </h3>
          <p className="mt-1 text-xs text-amber-800">
            These prompts are in a golden set but carry no tier, so they are excluded
            from tier figures until fixed &mdash; they are never silently dropped.
          </p>
          <ul className="mt-2 space-y-1">
            {goldenMembership.missingPriority.slice(0, 20).map((item) => (
              <li className="truncate text-xs text-amber-900" key={item.testItemId}>
                <Link
                  className="font-medium underline-offset-2 hover:underline"
                  href={`/admin/tests/${item.testId}`}
                >
                  {item.testName}
                </Link>{' '}
                &mdash; row {item.rowIndex}: {item.prompt}
              </li>
            ))}
            {goldenMembership.missingPriority.length > 20 ? (
              <li className="text-xs text-amber-800">
                &hellip;and {goldenMembership.missingPriority.length - 20} more.
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
