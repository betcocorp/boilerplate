export default function Loading() {
  return (
    <main className="min-w-0 space-y-6 p-4 sm:p-6">
      <div className="h-9 w-56 animate-pulse rounded-lg bg-muted" />
      <div className="h-64 w-full animate-pulse rounded-3xl bg-muted/60" />
      <div className="h-48 w-full animate-pulse rounded-3xl bg-muted/60" />
    </main>
  );
}
