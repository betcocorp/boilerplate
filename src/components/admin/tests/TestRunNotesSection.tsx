'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';

import { updateTestRunNotesAction } from '~/app/(authenticated)/admin/tests/actions';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Textarea } from '~/components/ui/textarea';

type TestRunNotesContextValue = {
  initialNotes: string | null;
  openDialog: () => void;
  hasNotes: boolean;
};

const TestRunNotesContext = createContext<TestRunNotesContextValue | null>(null);

function useTestRunNotes() {
  const ctx = useContext(TestRunNotesContext);
  if (!ctx) {
    throw new Error('TestRunNotes components must be used within TestRunNotesProvider');
  }
  return ctx;
}

type TestRunNotesProviderProps = {
  testId: string;
  runId: string;
  initialNotes: string | null;
  children: ReactNode;
};

export function TestRunNotesProvider({
  testId,
  runId,
  initialNotes,
  children,
}: TestRunNotesProviderProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(initialNotes ?? '');
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setDraft(initialNotes ?? '');
  }, [initialNotes]);

  const hasNotes = Boolean(initialNotes?.trim());

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) {
        setDraft(initialNotes ?? '');
      }
    },
    [initialNotes],
  );

  const openDialog = useCallback(() => setOpen(true), []);

  const handleSave = useCallback(() => {
    startTransition(async () => {
      const result = await updateTestRunNotesAction({
        testId,
        runId,
        notes: draft,
      });
      if (result.ok) {
        toast.success('Run notes saved.');
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }, [draft, runId, router, testId]);

  const contextValue = useMemo(
    () => ({
      initialNotes,
      openDialog,
      hasNotes,
    }),
    [hasNotes, initialNotes, openDialog],
  );

  return (
    <TestRunNotesContext.Provider value={contextValue}>
      {children}
      <Dialog onOpenChange={handleOpenChange} open={open}>
        <DialogContent className="sm:max-w-lg" showCloseButton>
          <DialogHeader>
            <DialogTitle>Run notes</DialogTitle>
            <DialogDescription>
              Record what changed for this run—dataset updates, similarity tweaks, model
              changes—so you can compare outcomes later.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            className="min-h-[160px] resize-y"
            disabled={pending}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. Raised chunk similarity threshold to 0.72; added 12 bathroom fixtures rows…"
            value={draft}
          />
          <DialogFooter>
            <Button
              disabled={pending}
              onClick={() => setOpen(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={pending} onClick={handleSave} type="button">
              {pending ? 'Saving…' : 'Save notes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TestRunNotesContext.Provider>
  );
}

/** Notes copy shown under the run title (no trigger button). */
export function TestRunNotesDisplay() {
  const { initialNotes, hasNotes } = useTestRunNotes();

  if (!hasNotes) {
    return null;
  }

  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">
        Run notes
      </p>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
        {initialNotes}
      </p>
    </div>
  );
}

/** Matches other header actions (outline, sm). */
export function TestRunNotesToolbarButton() {
  const { openDialog, hasNotes } = useTestRunNotes();

  return (
    <Button onClick={openDialog} size="sm" type="button" variant="outline">
      {hasNotes ? 'Edit notes' : 'Add run notes'}
    </Button>
  );
}
