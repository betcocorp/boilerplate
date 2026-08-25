'use client';

import { PlusIcon } from 'lucide-react';
import { useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { RoutingTestItemFields } from '~/components/admin/routing-test/RoutingTestItemFields';
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
import { Spinner } from '~/components/ui/spinner';
import { addRoutingTestItemAction } from '~/lib/routing-test/actions';

export function AddRoutingTestItemDialog() {
  const [open, setOpen] = useState(false);
  const [createAnother, setCreateAnother] = useState(false);
  const [isSaving, startSave] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  function closeDialog() {
    setOpen(false);
  }

  // Deliberately `onSubmit` + a direct call rather than `<form action={addRoutingTestItemAction}>`:
  // React 19 auto-resets a form's UNCONTROLLED fields after a `<form action>` succeeds, which also
  // stomps the "Create another" checkbox's DOM `checked` (a native reset, invisible to React) even
  // though it's controlled by `createAnother` — the checkbox then visibly unchecks itself despite
  // `createAnother` state staying true. Handling submission ourselves skips that behavior entirely.
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    startSave(async () => {
      const result = await addRoutingTestItemAction(formData);

      if (result.ok) {
        toast.success('Routing test item added.');
        if (createAnother) {
          // Keep the dialog open for another entry. Only the prompt clears — the expected agent
          // stays selected (batches of items are usually added for the same specialist) and the
          // checkbox stays checked (it only changes when the user touches it).
          const promptField = formRef.current?.querySelector<HTMLTextAreaElement>(
            'textarea[name="prompt"]',
          );
          if (promptField) promptField.value = '';
          promptField?.focus();
        } else {
          closeDialog();
        }
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : closeDialog())}>
      <DialogTrigger asChild>
        <Button size="sm" type="button">
          <PlusIcon className="size-4" />
          Add item
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add routing test item</DialogTitle>
          <DialogDescription>
            One prompt plus the SME agent it should route to. The routing test is
            a single flat list — there are no datasets to pick between.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={handleSubmit} ref={formRef}>
          <RoutingTestItemFields idPrefix="add-routing-test-item" />
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              checked={createAnother}
              className="size-4"
              onChange={(e) => setCreateAnother(e.target.checked)}
              type="checkbox"
            />
            Create another after saving
          </label>
          <DialogFooter className="gap-2 pt-2">
            <Button disabled={isSaving} type="submit">
              {isSaving ? <Spinner className="size-4" /> : null}
              Save item
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
