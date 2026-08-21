/**
 * B0-577 — placeholder slot for a Bex Health panel that is built in a later story. Keeps the
 * page's composition (and vertical order) stable while the real panels land one by one.
 */

export function PanelPlaceholder({ title }: { title: string }) {
  return (
    <section
      aria-label={title}
      className="rounded-3xl border border-dashed border-slate-300 bg-white/60 p-8"
    >
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      <p className="mt-1 text-sm text-slate-500">
        This panel has not been built yet — it arrives in a later story.
      </p>
    </section>
  );
}
