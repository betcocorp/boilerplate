'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { updateEscalationStatusAction } from '~/lib/escalations/escalation-actions';
import {
  ESCALATION_STATUSES,
  type EscalationStatus,
} from '~/lib/escalations/escalation-repository';

const STATUS_LABELS: Record<EscalationStatus, string> = {
  open: 'Open',
  in_review: 'In review',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

type EscalationStatusFormProps = {
  id: string;
  reference: string;
  initialStatus: EscalationStatus;
  initialNotes: string;
};

/**
 * B0-528 — one row's status + notes. Uses `onSubmit` + `preventDefault` rather than
 * `<form action={fn}>` on purpose: React 19 resets controlled inputs after a successful form
 * action, which would blank the notes field the moment it saved.
 */
export function EscalationStatusForm({
  id,
  reference,
  initialStatus,
  initialNotes,
}: EscalationStatusFormProps) {
  const router = useRouter();
  const [status, setStatus] = useState<EscalationStatus>(initialStatus);
  const [notes, setNotes] = useState(initialNotes);
  const [pending, startTransition] = useTransition();
  const dirty = status !== initialStatus || notes !== initialNotes;

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const result = await updateEscalationStatusAction({
            id,
            status,
            resolutionNotes: notes,
          });
          if (result.ok) {
            toast.success(`${reference} marked ${STATUS_LABELS[status].toLowerCase()}`);
            router.refresh();
          } else {
            toast.error(`Could not update ${reference}: ${result.error}`);
          }
        });
      }}
    >
      <div className="flex items-center gap-2">
        <select
          aria-label={`Status for ${reference}`}
          className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-900"
          disabled={pending}
          onChange={(event) => setStatus(event.target.value as EscalationStatus)}
          value={status}
        >
          {ESCALATION_STATUSES.map((value) => (
            <option key={value} value={value}>
              {STATUS_LABELS[value]}
            </option>
          ))}
        </select>
        <Button disabled={pending || !dirty} size="sm" type="submit" variant="outline">
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <Input
        aria-label={`Notes for ${reference}`}
        className="h-8 text-sm"
        disabled={pending}
        maxLength={4000}
        onChange={(event) => setNotes(event.target.value)}
        placeholder="Resolution notes (optional)"
        value={notes}
      />
    </form>
  );
}
