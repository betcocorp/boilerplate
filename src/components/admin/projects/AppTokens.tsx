'use client';

import { KeyRound, Loader2 } from 'lucide-react';
import { useActionState, useState } from 'react';
import { toast } from 'sonner';

import { TokenReveal } from '~/components/admin/projects/TokenReveal';
import { formatDate, formatLastUsed } from '~/components/admin/projects/format';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import {
  issueTokenAction,
  revokeTokenAction,
  type IssueTokenState,
  type SimpleActionState,
} from '~/lib/api/registry-actions';

export type TokenView = {
  id: string;
  label: string | null;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  status: 'active' | 'revoked' | 'expired';
};

const STATUS_STYLE: Record<TokenView['status'], string> = {
  active: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  revoked: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
  expired: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
};

function IssueTokenDialog({ projectId, appId }: { projectId: string; appId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<IssueTokenState, FormData>(issueTokenAction, null);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="rounded-2xl">
          <KeyRound className="size-4" />
          Issue token
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        {state?.ok ? (
          <>
            <DialogHeader>
              <DialogTitle>New token issued</DialogTitle>
              <DialogDescription>Copy it now — this is the only time it is shown.</DialogDescription>
            </DialogHeader>
            <TokenReveal token={state.token} label={state.label ?? state.prefix} />
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form action={formAction}>
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="appId" value={appId} />
            <DialogHeader>
              <DialogTitle>Issue a new token</DialogTitle>
              <DialogDescription>
                Add a labeled token to this app — issue a new one, deploy it, then revoke the old one
                for zero-downtime rotation.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-1.5">
                <Label htmlFor="tokenLabel">Label</Label>
                <Input id="tokenLabel" name="tokenLabel" placeholder="e.g. Vercel prod, CI smoke tests" />
              </div>
              {state && !state.ok ? <p className="text-sm text-rose-600">{state.error}</p> : null}
            </div>
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Issue token
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TokenRow({ projectId, appId, token }: { projectId: string; appId: string; token: TokenView }) {
  const [state, revoke, pending] = useActionState<SimpleActionState, FormData>(revokeTokenAction, null);

  const handleCopyPrefix = async () => {
    try {
      await navigator.clipboard.writeText(token.prefix);
      toast.success('Token prefix copied to clipboard');
    } catch {
      toast.error('Failed to copy prefix to clipboard');
    }
  };

  return (
    <TableRow className="border-border/60">
      <TableCell className="font-medium">{token.label ?? '—'}</TableCell>
      <TableCell
        className="cursor-pointer font-mono text-xs text-muted-foreground hover:text-foreground"
        onClick={handleCopyPrefix}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleCopyPrefix();
          }
        }}
      >
        {token.prefix}…
      </TableCell>
      <TableCell className="text-muted-foreground">{formatDate(token.createdAt)}</TableCell>
      <TableCell className="text-muted-foreground">{formatLastUsed(token.lastUsedAt)}</TableCell>
      <TableCell>
        <Badge variant="secondary" className={STATUS_STYLE[token.status]}>
          {token.status}
        </Badge>
      </TableCell>
      <TableCell className="text-right">
        {token.status === 'active' ? (
          <form action={revoke}>
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="appId" value={appId} />
            <input type="hidden" name="keyId" value={token.id} />
            <Button type="submit" variant="ghost" size="sm" disabled={pending} className="text-rose-600 hover:text-rose-700">
              {pending ? '…' : 'Revoke'}
            </Button>
            {state && !state.ok ? <span className="ml-2 text-xs text-rose-600">{state.error}</span> : null}
          </form>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

export function AppTokens({
  projectId,
  appId,
  tokens,
}: {
  projectId: string;
  appId: string;
  tokens: TokenView[];
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {tokens.filter((t) => t.status === 'active').length} active of {tokens.length} total.
        </p>
        <IssueTokenDialog projectId={projectId} appId={appId} />
      </div>
      {tokens.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tokens yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-border/60 hover:bg-transparent">
                <TableHead>Label</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((token) => (
                <TokenRow key={token.id} projectId={projectId} appId={appId} token={token} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
