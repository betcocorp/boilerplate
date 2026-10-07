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
import { Textarea } from '~/components/ui/textarea';
import {
  createProjectWizardAction,
  type CreateProjectWizardState,
} from '~/lib/api/registry-actions';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function CreateProjectWizard() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [stepError, setStepError] = useState<string | null>(null);
  const [values, setValues] = useState({
    projectName: '',
    description: '',
    contactEmail: '',
    appName: '',
    tokenLabel: '',
  });
  const [state, formAction, pending] = useActionState<CreateProjectWizardState, FormData>(
    createProjectWizardAction,
    null,
  );

  const done = state?.ok === true;

  const set = (k: keyof typeof values) => (v: string) => setValues((s) => ({ ...s, [k]: v }));

  function next() {
    if (step === 1) {
      if (!values.projectName.trim()) return setStepError('Project name is required.');
      if (values.contactEmail.trim() && !EMAIL_RE.test(values.contactEmail.trim())) {
        return setStepError('Enter a valid contact email.');
      }
    }
    if (step === 2 && !values.appName.trim()) return setStepError('App name is required.');
    setStepError(null);
    setStep((s) => Math.min(3, s + 1));
  }

  function reset() {
    setOpen(false);
    setStep(1);
    setStepError(null);
    setValues({
      projectName: '',
      description: '',
      contactEmail: '',
      appName: '',
      tokenLabel: '',
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : reset())}>
      <DialogTrigger asChild>
        <Button className="rounded-2xl">
          <Plus className="size-4" />
          New project
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        {done && state?.ok ? (
          <>
            <DialogHeader>
              <DialogTitle>Token for {state.appName}</DialogTitle>
              <DialogDescription>
                {state.projectName} → {state.appName} is created. Here is its first token.
              </DialogDescription>
            </DialogHeader>
            <TokenReveal token={state.token} label={state.prefix} />
            <DialogFooter>
              <Button onClick={reset}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form action={formAction}>
            <DialogHeader>
              <DialogTitle>New project</DialogTitle>
              <DialogDescription>
                Step {step} of 3 — {step === 1 ? 'project' : step === 2 ? 'first app' : 'first token'}.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              {/* Step 1 — project */}
              <div className={step === 1 ? 'space-y-4' : 'hidden'}>
                <div className="space-y-1.5">
                  <Label htmlFor="projectName">Project name</Label>
                  <Input
                    id="projectName"
                    name="projectName"
                    placeholder="e.g. C360"
                    value={values.projectName}
                    onChange={(e) => set('projectName')(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    name="description"
                    placeholder="What the integration does"
                    value={values.description}
                    onChange={(e) => set('description')(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="contactEmail">Contact email</Label>
                  <Input
                    id="contactEmail"
                    name="contactEmail"
                    type="email"
                    placeholder="owner@example.com"
                    value={values.contactEmail}
                    onChange={(e) => set('contactEmail')(e.target.value)}
                  />
                </div>
              </div>

              {/* Step 2 — app */}
              <div className={step === 2 ? 'space-y-4' : 'hidden'}>
                <div className="space-y-1.5">
                  <Label htmlFor="appName">App name</Label>
                  <Input
                    id="appName"
                    name="appName"
                    placeholder="e.g. Web"
                    value={values.appName}
                    onChange={(e) => set('appName')(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    A runtime surface of this project (e.g. Web, Mobile, CI).
                  </p>
                </div>
              </div>

              {/* Step 3 — token */}
              <div className={step === 3 ? 'space-y-4' : 'hidden'}>
                <div className="space-y-1.5">
                  <Label htmlFor="tokenLabel">Token label</Label>
                  <Input
                    id="tokenLabel"
                    name="tokenLabel"
                    placeholder="e.g. Vercel prod"
                    value={values.tokenLabel}
                    onChange={(e) => set('tokenLabel')(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    The full token is shown once, right after you create the project.
                  </p>
                </div>
              </div>

              {(stepError || (state && !state.ok)) && (
                <p className="text-sm text-rose-600">
                  {stepError ?? (state && !state.ok ? state.error : null)}
                </p>
              )}
            </div>

            <DialogFooter className="sm:justify-between">
              <Button
                type="button"
                variant="ghost"
                disabled={step === 1 || pending}
                onClick={() => {
                  setStepError(null);
                  setStep((s) => Math.max(1, s - 1));
                }}
              >
                Back
              </Button>
              {step < 3 ? (
                <Button type="button" onClick={next}>
                  Next
                </Button>
              ) : (
                <Button type="submit" disabled={pending}>
                  {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Create project
                </Button>
              )}
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
