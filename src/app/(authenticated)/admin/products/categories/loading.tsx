export default function Loading() {
  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-6 px-6 py-10 sm:px-8">
        <div className="h-8 w-64 animate-pulse rounded-lg bg-slate-200" />
        <div className="h-24 w-full animate-pulse rounded-2xl bg-slate-100" />
        <div className="h-96 w-full animate-pulse rounded-2xl bg-slate-100" />
      </main>
    </div>
  );
}
