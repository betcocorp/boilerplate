'use client';

import { useActionState } from 'react';

import { Button } from '~/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  setAppActiveAction,
  updateAppAction,
  type SimpleActionState,
} from '~/lib/api/registry-actions';

type AppSettings = {
  id: string;
  projectId: string;
  name: string;
  rateLimitPerMinute: number | null;
  isActive: boolean;
};

export function AppSettingsCard({ app }: { app: AppSettings }) {
  const [editState, edit, editPending] = useActionState<SimpleActionState, FormData>(
    updateAppAction,
    null,
  );
  const [toggleState, toggle, togglePending] = useActionState<SimpleActionState, FormData>(
    setAppActiveAction,
    null,
  );

  return (
    <Card className="rounded-3xl border border-border/60 shadow-none">
      <CardHeader>
        <CardTitle className="text-lg">App settings</CardTitle>
        <CardDescription>Name, environment, per-minute rate limit, and the app kill switch.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <form action={edit} className="space-y-4">
          <input type="hidden" name="projectId" value={app.projectId} />
          <input type="hidden" name="appId" value={app.id} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" defaultValue={app.name} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rateLimitPerMinute">Rate limit / min</Label>
              <Input
                id="rateLimitPerMinute"
                name="rateLimitPerMinute"
                type="number"
                min={1}
                defaultValue={app.rateLimitPerMinute ?? ''}
                placeholder="Unlimited"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={editPending}>
              {editPending ? 'Saving…' : 'Save changes'}
            </Button>
            {editState?.ok ? <span className="text-sm text-emerald-600">Saved.</span> : null}
            {editState && !editState.ok ? (
              <span className="text-sm text-rose-600">{editState.error}</span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">Leave the rate limit empty for unlimited.</p>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/60 bg-muted/30 p-4">
          <div>
            <p className="text-sm font-medium">Kill switch — app is {app.isActive ? 'active' : 'disabled'}</p>
            <p className="text-xs text-muted-foreground">
              Disabling instantly 401s every token on this app (the project&apos;s other apps are unaffected).
            </p>
            {toggleState && !toggleState.ok ? (
              <p className="mt-1 text-xs text-rose-600">{toggleState.error}</p>
            ) : null}
          </div>
          <form action={toggle}>
            <input type="hidden" name="projectId" value={app.projectId} />
            <input type="hidden" name="appId" value={app.id} />
            <input type="hidden" name="isActive" value={String(!app.isActive)} />
            <Button type="submit" variant={app.isActive ? 'destructive' : 'default'} disabled={togglePending}>
              {togglePending ? '…' : app.isActive ? 'Disable app' : 'Enable app'}
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  );
}
