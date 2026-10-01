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
import { Textarea } from '~/components/ui/textarea';
import {
  setProjectActiveAction,
  updateProjectAction,
  type SimpleActionState,
} from '~/lib/api/registry-actions';

type ProjectSettings = {
  id: string;
  name: string;
  description: string | null;
  contactEmail: string | null;
  isActive: boolean;
};

export function ProjectSettingsCard({ project }: { project: ProjectSettings }) {
  const [editState, edit, editPending] = useActionState<SimpleActionState, FormData>(
    updateProjectAction,
    null,
  );
  const [toggleState, toggle, togglePending] = useActionState<SimpleActionState, FormData>(
    setProjectActiveAction,
    null,
  );

  return (
    <Card className="rounded-3xl border border-border/60 shadow-none">
      <CardHeader>
        <CardTitle className="text-lg">Project settings</CardTitle>
        <CardDescription>Editable fields and the project-wide kill switch.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <form action={edit} className="space-y-4">
          <input type="hidden" name="projectId" value={project.id} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" defaultValue={project.name} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contactEmail">Contact email</Label>
              <Input
                id="contactEmail"
                name="contactEmail"
                type="email"
                defaultValue={project.contactEmail ?? ''}
                placeholder="owner@example.com"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" name="description" defaultValue={project.description ?? ''} />
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
        </form>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/60 bg-muted/30 p-4">
          <div>
            <p className="text-sm font-medium">
              Kill switch — project is {project.isActive ? 'active' : 'disabled'}
            </p>
            <p className="text-xs text-muted-foreground">
              Disabling instantly 401s every app and token under this project (reversible).
            </p>
            {toggleState && !toggleState.ok ? (
              <p className="mt-1 text-xs text-rose-600">{toggleState.error}</p>
            ) : null}
          </div>
          <form action={toggle}>
            <input type="hidden" name="projectId" value={project.id} />
            <input type="hidden" name="isActive" value={String(!project.isActive)} />
            <Button
              type="submit"
              variant={project.isActive ? 'destructive' : 'default'}
              disabled={togglePending}
            >
              {togglePending ? '…' : project.isActive ? 'Disable project' : 'Enable project'}
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  );
}
