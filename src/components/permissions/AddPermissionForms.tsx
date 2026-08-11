'use client';

import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { FormDateField } from '~/components/permissions/FormDateField';
import {
  PERMISSIONS_API_BASE,
  envelopeErrorMessage,
  readJsonEnvelope,
} from '~/components/permissions/api';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader } from '~/components/ui/card';
import { Checkbox } from '~/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '~/components/ui/collapsible';
import { Form } from '~/components/ui/form';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';

/**
 * Collapsible "Add …" card shared by the three creation forms. Same shape as c360's, restyled to the
 * bex admin card conventions (`rounded-3xl border border-border/60 shadow-none`).
 */
function AddFormCard({
  children,
  onOpenChange,
  open,
  title,
}: {
  children: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}) {
  return (
    <Card className="mb-4 gap-0 rounded-3xl border border-border/60 py-4 shadow-none">
      <Collapsible onOpenChange={onOpenChange} open={open}>
        <CollapsibleTrigger className="w-full text-left">
          <CardHeader className="gap-0 py-0">
            <div className="flex items-center justify-between">
              <span className="text-lg font-semibold">{title}</span>
              {open ? (
                <ChevronUp className="size-5 text-muted-foreground" />
              ) : (
                <ChevronDown className="size-5 text-muted-foreground" />
              )}
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-4">{children}</CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

/** "To add more, check this box" — keeps the card open after a successful create. */
function AddMoreToggle({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
      <Checkbox
        aria-label="To add more, check this box"
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      To add more, check this box
    </label>
  );
}

function SubmitButton({ label, saving }: { label: string; saving: boolean }) {
  return (
    <Button className="rounded-2xl" disabled={saving} type="submit">
      {saving ? (
        <>
          <Loader2 className="size-4 animate-spin" />
          Creating…
        </>
      ) : (
        label
      )}
    </Button>
  );
}

export function AddGroupForm() {
  const router = useRouter();
  const dateForm = useForm<{ startAt?: string; endAt?: string }>({
    defaultValues: { startAt: undefined, endAt: undefined },
  });
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addMore, setAddMore] = useState(false);
  const [selector, setSelector] = useState('');
  const [description, setDescription] = useState('');

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selector.trim()) {
      toast.error('Selector is required');
      return;
    }
    const { startAt, endAt } = dateForm.getValues();
    setSaving(true);
    try {
      const res = await fetch(`${PERMISSIONS_API_BASE}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selector: selector.trim(),
          description: description.trim() || undefined,
          startAt: startAt || undefined,
          endAt: endAt || undefined,
        }),
      });
      const data = await readJsonEnvelope(res);
      if (!res.ok) {
        toast.error(envelopeErrorMessage(data, 'Failed to create group'));
        return;
      }
      toast.success('Group created');
      setSelector('');
      setDescription('');
      dateForm.reset({ startAt: undefined, endAt: undefined });
      if (!addMore) setOpen(false);
      router.refresh();
    } catch (err) {
      console.error(err);
      toast.error('Failed to create group');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AddFormCard onOpenChange={setOpen} open={open} title="Add Group">
      <Form {...dateForm}>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="group-selector">Selector</Label>
              <Input
                id="group-selector"
                onChange={(event) => setSelector(event.target.value)}
                placeholder="e.g. customer_service"
                required
                value={selector}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="group-description">Description (optional)</Label>
              <Input
                id="group-description"
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Short description"
                value={description}
              />
            </div>
            <div className="space-y-2">
              <FormDateField
                control={dateForm.control}
                label="Start At (optional)"
                name="startAt"
                placeholder="Select start date"
              />
            </div>
            <div className="space-y-2">
              <FormDateField
                control={dateForm.control}
                label="End At (optional)"
                name="endAt"
                placeholder="Select end date"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton label="Create Group" saving={saving} />
            <AddMoreToggle checked={addMore} onCheckedChange={setAddMore} />
          </div>
        </form>
      </Form>
    </AddFormCard>
  );
}

export function AddUserForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addMore, setAddMore] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !email.trim()) {
      toast.error('Name and email are required');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${PERMISSIONS_API_BASE}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim() }),
      });
      const data = await readJsonEnvelope(res);
      if (!res.ok) {
        toast.error(envelopeErrorMessage(data, 'Failed to create user'));
        return;
      }
      toast.success('User created');
      setName('');
      setEmail('');
      if (!addMore) setOpen(false);
      router.refresh();
    } catch (err) {
      console.error(err);
      toast.error('Failed to create user');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AddFormCard onOpenChange={setOpen} open={open} title="Add User">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="user-name">Name</Label>
            <Input
              id="user-name"
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Jane Smith"
              required
              type="text"
              value={name}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="user-email">Email</Label>
            <Input
              id="user-email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="e.g. jane@example.com"
              required
              type="email"
              value={email}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton label="Create User" saving={saving} />
          <AddMoreToggle checked={addMore} onCheckedChange={setAddMore} />
        </div>
      </form>
    </AddFormCard>
  );
}

export function AddPermissionForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addMore, setAddMore] = useState(false);
  const [selector, setSelector] = useState('');
  const [description, setDescription] = useState('');

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selector.trim()) {
      toast.error('Selector is required');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(PERMISSIONS_API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selector: selector.trim(),
          description: description.trim() || undefined,
        }),
      });
      const data = await readJsonEnvelope(res);
      if (!res.ok) {
        toast.error(envelopeErrorMessage(data, 'Failed to create permission'));
        return;
      }
      toast.success('Permission created');
      setSelector('');
      setDescription('');
      if (!addMore) setOpen(false);
      router.refresh();
    } catch (err) {
      console.error(err);
      toast.error('Failed to create permission');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AddFormCard onOpenChange={setOpen} open={open} title="Add Permission">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="permission-selector">Selector</Label>
            <Input
              id="permission-selector"
              onChange={(event) => setSelector(event.target.value)}
              placeholder="e.g. navigation.sidebar.bex"
              required
              value={selector}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="permission-description">
              Description (optional)
            </Label>
            <Input
              id="permission-description"
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Short description"
              value={description}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton label="Create Permission" saving={saving} />
          <AddMoreToggle checked={addMore} onCheckedChange={setAddMore} />
        </div>
      </form>
    </AddFormCard>
  );
}
