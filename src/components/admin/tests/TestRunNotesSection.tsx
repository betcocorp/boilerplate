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

import { ChevronDown, Info } from 'lucide-react';

import { updateTestRunNotesAction } from '~/app/(authenticated)/admin/tests/actions';
import { Button } from '~/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '~/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Textarea } from '~/components/ui/textarea';
import { cn } from '~/lib/utils';

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

/** Notes copy shown under the run title (collapsed by default; expand to read). */
export function TestRunNotesDisplay() {
  const { initialNotes, hasNotes } = useTestRunNotes();

  if (!hasNotes) {
    return null;
  }

  return (
    <Collapsible className="group mt-3 w-full rounded-xl border border-slate-200 bg-slate-50/80">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-4 py-3 text-left outline-none transition-colors hover:bg-slate-100/80 focus-visible:ring-2 focus-visible:ring-sky-600/40 focus-visible:ring-offset-2">
        <Info
          aria-hidden
          className="size-4 shrink-0 text-sky-700"
          strokeWidth={2}
        />
        <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
          Run notes
        </span>
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 text-slate-500 transition-transform duration-200 group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          'overflow-hidden outline-none',
          'data-[state=closed]:animate-out data-[state=open]:animate-in',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2',
          'duration-200',
        )}
      >
        <div className="border-t border-slate-200 px-4 pb-3 pt-2">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
            {initialNotes}
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
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
