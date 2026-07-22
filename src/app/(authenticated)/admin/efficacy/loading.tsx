export default function AdminEfficacyLoading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-6 px-6 py-10 sm:px-8">
        <div className="h-36 animate-pulse rounded-3xl bg-slate-200/70" />
        <div className="h-[560px] animate-pulse rounded-3xl bg-slate-200/70" />
      </main>
    </div>
  );
}
