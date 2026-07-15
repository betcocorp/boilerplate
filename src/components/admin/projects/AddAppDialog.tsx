'use client';

import { Loader2, Plus } from 'lucide-react';
import { useActionState, useState } from 'react';

import { TokenReveal } from '~/components/admin/projects/TokenReveal';
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
import { NativeSelect } from '~/components/ui/native-select';
import { addAppAction, type AddAppState } from '~/lib/api/registry-actions';

export function AddAppDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [issueToken, setIssueToken] = useState(true);
  const [state, formAction, pending] = useActionState<AddAppState, FormData>(addAppAction, null);

  const revealed = state?.ok === true && state.token;

  function close() {
    setOpen(false);
    setIssueToken(true);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogTrigger asChild>
        <Button variant="outline" className="rounded-2xl">
          <Plus className="size-4" />
          Add app
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        {state?.ok ? (
          <>
            <DialogHeader>
              <DialogTitle>App “{state.appName}” created</DialogTitle>
              <DialogDescription>
                {revealed
                  ? `First token issued for the ${state.environment} app.`
                  : 'No token was issued — you can create one from the app detail page.'}
              </DialogDescription>
            </DialogHeader>
            {revealed && state.token ? <TokenReveal token={state.token} label={state.prefix} /> : null}
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form action={formAction}>
            <input type="hidden" name="projectId" value={projectId} />
            <DialogHeader>
              <DialogTitle>Add app</DialogTitle>
              <DialogDescription>A runtime surface of this project, tied to an environment.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-1.5">
                <Label htmlFor="appName">App name</Label>
                <Input id="appName" name="appName" placeholder="e.g. Web" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="environment">Environment</Label>
                <NativeSelect id="environment" name="environment" defaultValue="production">
                  <option value="production">production</option>
                  <option value="staging">staging</option>
                  <option value="development">development</option>
                </NativeSelect>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="issueToken"
                  checked={issueToken}
                  onChange={(e) => setIssueToken(e.target.checked)}
                />
                Issue a first token now (shown once)
              </label>
              {issueToken ? (
                <div className="space-y-1.5">
                  <Label htmlFor="tokenLabel">Token label</Label>
                  <Input id="tokenLabel" name="tokenLabel" placeholder="e.g. Vercel prod" />
                </div>
              ) : null}
              {state && !state.ok ? <p className="text-sm text-rose-600">{state.error}</p> : null}
            </div>
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Create app
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
