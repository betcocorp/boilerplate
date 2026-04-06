import { Loader2 } from 'lucide-react';

export default function BexChatLoading() {
  return (
    <div className="flex min-h-[50vh] flex-1 items-center justify-center gap-3 text-muted-foreground">
      <Loader2 className="size-6 animate-spin" aria-hidden />
      <span className="text-sm font-medium">Opening Bex…</span>
    </div>
  );
}
