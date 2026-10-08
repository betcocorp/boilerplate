import type { ThursdayScorecardSnapshot } from '~/lib/tests/thursday-scorecard-schemas';

function ScorecardCard({
  title,
  items,
}: {
  title: string;
  items: readonly string[];
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-5">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">
          Nothing to highlight for this sweep.
        </p>
      ) : (
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-slate-700">
          {items.map((item, index) => (
            <li key={`${index}:${item}`}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ThursdayScorecardCards({
  snapshot,
}: {
  snapshot: ThursdayScorecardSnapshot;
}) {
  return (
    <div className="mt-6 grid gap-4 md:grid-cols-2">
      <ScorecardCard items={snapshot.highlights} title="Executive highlights" />
      <ScorecardCard items={snapshot.notes} title="Data notes & review flags" />
    </div>
  );
}
