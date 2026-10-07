'use client';

import { Check, Copy, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { Button } from '~/components/ui/button';

/**
 * Show-once token display. The full token is rendered here exactly once (in a creation modal) with
 * copy-to-clipboard and a "you won't see this again" warning; afterward only the prefix is shown
 * anywhere. Presentational + client-only (clipboard) — never persists or refetches the token.
 */
export function TokenReveal({ token, label }: { token: string; label?: string | null }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <p>
          Copy this token now — it is shown <strong>once</strong> and cannot be retrieved again.
          Store it only in server-side environment variables, never in client code.
        </p>
      </div>
      {label ? <p className="text-xs text-muted-foreground">Label: {label}</p> : null}
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-xl border border-border/60 bg-muted px-3 py-2 font-mono text-xs">
          {token}
        </code>
        <Button type="button" variant="secondary" size="sm" onClick={copy} className="shrink-0">
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
