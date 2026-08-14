'use client';

import { ChevronDown, Loader2, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { BetcoProductPicker } from '~/components/admin/BetcoProductPicker';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '~/components/ui/collapsible';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog';
import { Label } from '~/components/ui/label';
import { Textarea } from '~/components/ui/textarea';
import {
  addRecommendationCandidate,
  editRecommendationCandidate,
  rejectRecommendation,
  verifyRecommendation,
} from '~/lib/recommendations/review-actions';
import type {
  RecommendationCandidate,
  RecommendationStatus,
  RecommendationWithCandidates,
} from '~/lib/recommendations/recommendation-schemas';
import { getErrorMessage } from '~/lib/utils';

const STATUS_BADGE_VARIANT: Record<
  RecommendationStatus,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  pending: 'outline',
  answered: 'secondary',
  declined: 'outline',
  verified: 'default',
  rejected: 'destructive',
};

function formatPercent(value: number | null) {
  return value == null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function formatDate(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

/** Extracts the human verifier note left by `updateRecommendationStatus` (evidence.verification). */
function readVerification(evidence: Record<string, unknown>) {
  const v = evidence.verification as
    | { verifier?: string | null; note?: string | null; status?: string; at?: string }
    | undefined;
  return v ?? null;
}

function CandidateCard({
  candidate,
  selected,
  onSelect,
  disabled,
}: {
  candidate: RecommendationCandidate;
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [betcoTitle, setBetcoTitle] = useState(candidate.betcoTitle ?? '');
  const [betcoProductKey, setBetcoProductKey] = useState(candidate.betcoProductKey ?? '');
  const [rationale, setRationale] = useState(candidate.rationale ?? '');
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function saveEdit() {
    startTransition(async () => {
      try {
        await editRecommendationCandidate(candidate.id, {
          betcoTitle: betcoTitle.trim() || null,
          betcoProductKey: betcoProductKey.trim() || null,
          rationale: rationale.trim() || null,
        });
        toast.success('Candidate updated');
        setEditing(false);
        router.refresh();
      } catch (err) {
        toast.error(getErrorMessage(err, 'Failed to update candidate'));
      }
    });
  }

  return (
    <li className="rounded-2xl border border-border/60 bg-muted/30 p-4">
      <div className="flex items-start gap-3">
        <input
          aria-label={`Choose ${candidate.betcoTitle ?? 'this candidate'} as the verified match`}
          checked={selected}
          className="mt-1"
          disabled={disabled}
          name="chosen-candidate"
          onChange={onSelect}
          type="radio"
        />
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-2">
              <BetcoProductPicker
                idPrefix={`candidate-${candidate.id}`}
                onChange={({ betcoProductKey: key, betcoTitle: title }) => {
                  setBetcoProductKey(key);
                  setBetcoTitle(title);
                }}
                value={{ betcoProductKey, betcoTitle }}
              />
              <div className="space-y-1">
                <Label htmlFor={`rationale-${candidate.id}`}>Rationale</Label>
                <Textarea
                  id={`rationale-${candidate.id}`}
                  onChange={(e) => setRationale(e.target.value)}
                  value={rationale}
                />
              </div>
              <div className="flex gap-2">
                <Button disabled={isPending} onClick={saveEdit} size="sm" type="button">
                  {isPending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
                  Save
                </Button>
                <Button
                  onClick={() => setEditing(false)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium text-foreground">{candidate.betcoTitle ?? 'Betco product'}</p>
                <span className="text-xs text-muted-foreground">
                  #{candidate.rank ?? '—'}
                  {candidate.candidateConfidence != null
                    ? ` · ${formatPercent(candidate.candidateConfidence)}`
                    : ''}
                </span>
              </div>
              {candidate.betcoProductKey ? (
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {candidate.betcoProductKey}
                  {candidate.betcoProdId ? ` · ${candidate.betcoProdId}` : ''}
                </p>
              ) : null}
              {candidate.rationale ? (
                <p className="mt-2 text-sm text-muted-foreground">{candidate.rationale}</p>
              ) : null}
              <Button
                className="mt-2 h-auto p-0 text-xs"
                onClick={() => setEditing(true)}
                size="sm"
                type="button"
                variant="link"
              >
                Edit chosen candidate
              </Button>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * B0-433 — reviewer-authored candidate for a recommendation the engine returned nothing usable for.
 * Betco title and product key are both required because promotion into the fast-path override table
 * needs both; letting either through would just produce another candidate that cannot be approved.
 */
function AddCandidateForm({
  recommendationId,
  onAdded,
  disabled,
}: {
  recommendationId: string;
  onAdded: (candidateId: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [betcoTitle, setBetcoTitle] = useState('');
  const [betcoProductKey, setBetcoProductKey] = useState('');
  const [rationale, setRationale] = useState('');
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const canSubmit = betcoTitle.trim().length > 0 && betcoProductKey.trim().length > 0;

  function submit() {
    if (!canSubmit) {
      toast.error('A Betco title and product key are both required.');
      return;
    }
    startTransition(async () => {
      try {
        const created = await addRecommendationCandidate(recommendationId, {
          betcoTitle: betcoTitle.trim(),
          betcoProductKey: betcoProductKey.trim(),
          rationale: rationale.trim() || null,
        });
        toast.success('Candidate added');
        onAdded(created.id);
        setBetcoTitle('');
        setBetcoProductKey('');
        setRationale('');
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(getErrorMessage(err, 'Failed to add candidate'));
      }
    });
  }

  if (!open) {
    return (
      <Button
        className="mt-2"
        disabled={disabled}
        onClick={() => setOpen(true)}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="mr-2 size-3.5" />
        Add a candidate
      </Button>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-2xl border border-dashed border-border p-4">
      <p className="text-sm font-medium text-foreground">Add a candidate</p>
      <BetcoProductPicker
        idPrefix={`add-candidate-${recommendationId}`}
        onChange={({ betcoProductKey: key, betcoTitle: title }) => {
          setBetcoProductKey(key);
          setBetcoTitle(title);
        }}
        value={{ betcoProductKey, betcoTitle }}
      />
      <div className="space-y-1">
        <Label htmlFor={`add-rationale-${recommendationId}`}>Rationale</Label>
        <Textarea
          id={`add-rationale-${recommendationId}`}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="Why this Betco product is the right cross-reference."
          value={rationale}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        A Betco product (title and key) is required — the fast-path override table needs both, so a
        candidate missing either cannot be approved. Pick from the search above, or use &ldquo;enter
        a key manually&rdquo; for a legacy product with no search entry.
      </p>
      <div className="flex gap-2">
        <Button disabled={isPending || !canSubmit} onClick={submit} size="sm" type="button">
          {isPending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : null}
          Add candidate
        </Button>
        <Button onClick={() => setOpen(false)} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function RecommendationRowPanel({
  recommendation,
}: {
  recommendation: RecommendationWithCandidates;
}) {
  const [open, setOpen] = useState(false);
  const [chosenCandidateId, setChosenCandidateId] = useState<string | null>(
    recommendation.candidates[0]?.id ?? null,
  );
  const [rejectReason, setRejectReason] = useState('');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const isDecided = recommendation.status === 'verified' || recommendation.status === 'rejected';
  const verification = readVerification(recommendation.evidence);

  /**
   * B0-433 — the same preconditions `promoteRecommendationToOverride` enforces server-side, checked
   * up front so the reviewer sees what is missing instead of approving into a silent no-op.
   */
  const chosenCandidate = recommendation.candidates.find((c) => c.id === chosenCandidateId) ?? null;
  const blockingReason: string | null = !chosenCandidate
    ? recommendation.candidates.length === 0
      ? 'No candidate to approve — add one below first.'
      : 'Select a candidate to approve.'
    : !chosenCandidate.betcoProductKey?.trim()
      ? 'The selected candidate has no Betco product key. Add it with "Edit chosen candidate" before approving.'
      : !chosenCandidate.betcoTitle?.trim()
        ? 'The selected candidate has no Betco title. Add it with "Edit chosen candidate" before approving.'
        : !recommendation.competitorBrand?.trim()
          ? 'This recommendation has no competitor brand recorded, which the fast-path mapping requires.'
          : null;

  function handleVerify() {
    startTransition(async () => {
      try {
        const result = await verifyRecommendation(recommendation.id, { chosenCandidateId });
        // B0-433 — approving and promoting can disagree; report what actually happened rather
        // than always claiming the fast-path mapping is live.
        if (result.promoted) {
          toast.success(
            result.mode === 'updated'
              ? 'Approved — existing fast-path mapping updated'
              : 'Approved and promoted to the fast-path mapping',
          );
        } else {
          toast.warning(`Approved, but not promoted: ${result.reason}`);
        }
        router.refresh();
      } catch (err) {
        toast.error(getErrorMessage(err, 'Failed to approve recommendation'));
      }
    });
  }

  function handleReject() {
    if (!rejectReason.trim()) {
      toast.error('A rejection reason is required.');
      return;
    }
    startTransition(async () => {
      try {
        await rejectRecommendation(recommendation.id, { reason: rejectReason.trim() });
        toast.success('Recommendation rejected');
        setRejectOpen(false);
        setRejectReason('');
        router.refresh();
      } catch (err) {
        toast.error(getErrorMessage(err, 'Failed to reject recommendation'));
      }
    });
  }

  const evidence = recommendation.evidence as {
    source?: string;
    sources?: Array<{ url: string; title?: string }>;
    webSearch?: {
      searchesUsed?: number;
      estimatedCostUsd?: number;
      escalated?: boolean;
      budgetExceeded?: boolean;
    } | null;
    spec?: Record<string, unknown> | null;
  };

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <div className="rounded-2xl border border-border/60">
        <CollapsibleTrigger asChild>
          <button
            className="flex w-full flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left hover:bg-muted/40"
            type="button"
          >
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">
                {recommendation.competitorBrand ? `${recommendation.competitorBrand} — ` : ''}
                {recommendation.competitorProduct}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDate(recommendation.createdAt)} · {recommendation.candidates.length} candidate
                {recommendation.candidates.length === 1 ? '' : 's'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={STATUS_BADGE_VARIANT[recommendation.status]}>
                {recommendation.status}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {formatPercent(recommendation.overallConfidence)} conf. · threshold{' '}
                {formatPercent(recommendation.thresholdUsed)}
              </span>
              <ChevronDown
                className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
              />
            </div>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="space-y-4 border-t border-border/60 p-4">
            {verification ? (
              <p className="text-xs text-muted-foreground">
                Last reviewed by {verification.verifier ?? 'unknown'}
                {verification.at ? ` on ${formatDate(verification.at)}` : ''}
                {verification.note ? ` — "${verification.note}"` : ''}
              </p>
            ) : null}

            {!recommendation.answerGiven && recommendation.declineReason ? (
              <p className="rounded-xl border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                Declined: {recommendation.declineReason}
              </p>
            ) : null}

            <div>
              <p className="text-sm font-medium text-foreground">Candidates</p>
              <p className="mb-2 text-xs text-muted-foreground">
                Select the correct Betco match, then Approve to promote it into the fast-path
                cross-reference override table.
              </p>
              {recommendation.candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No candidates were retrieved. Add one below to approve this recommendation.
                </p>
              ) : (
                <ul className="space-y-3">
                  {recommendation.candidates.map((c) => (
                    <CandidateCard
                      candidate={c}
                      disabled={isDecided}
                      key={c.id}
                      onSelect={() => setChosenCandidateId(c.id)}
                      selected={chosenCandidateId === c.id}
                    />
                  ))}
                </ul>
              )}
              {!isDecided ? (
                <AddCandidateForm
                  disabled={isPending}
                  onAdded={setChosenCandidateId}
                  recommendationId={recommendation.id}
                />
              ) : null}
            </div>

            <div className="rounded-2xl border border-border/60 p-4">
              <p className="text-sm font-medium text-foreground">Web-search evidence</p>
              <p className="mt-1 text-xs text-muted-foreground">Source: {evidence.source ?? 'unknown'}</p>
              {evidence.webSearch ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {evidence.webSearch.searchesUsed ?? 0} search(es)
                  {evidence.webSearch.escalated ? ' · escalated' : ''}
                  {evidence.webSearch.budgetExceeded ? ' · budget exceeded' : ''} · est. $
                  {(evidence.webSearch.estimatedCostUsd ?? 0).toFixed(3)}
                </p>
              ) : null}
              {evidence.sources && evidence.sources.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {evidence.sources.map((s, i) => (
                    <li className="truncate text-sm" key={`${s.url}-${i}`}>
                      <a
                        className="text-primary underline-offset-4 hover:underline"
                        href={s.url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {s.title ?? s.url}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">No web sources (legacy match).</p>
              )}
            </div>

            {!isDecided ? (
              <div className="space-y-2">
                {blockingReason ? (
                  <p className="text-xs text-amber-700 dark:text-amber-400">{blockingReason}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={isPending || blockingReason !== null}
                    onClick={handleVerify}
                    type="button"
                  >
                    {isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                    Approve
                  </Button>

                  <Dialog onOpenChange={setRejectOpen} open={rejectOpen}>
                    <DialogTrigger asChild>
                      <Button disabled={isPending} type="button" variant="outline">
                        Reject
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Reject recommendation</DialogTitle>
                        <DialogDescription>
                          Explain why this recommendation is wrong. This is recorded on the
                          recommendation and in the audit log.
                        </DialogDescription>
                      </DialogHeader>
                      <Textarea
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="e.g. Wrong chemistry class — this is a degreaser, not a disinfectant."
                        value={rejectReason}
                      />
                      <DialogFooter>
                        <DialogClose asChild>
                          <Button type="button" variant="ghost">
                            Cancel
                          </Button>
                        </DialogClose>
                        <Button disabled={isPending} onClick={handleReject} type="button" variant="destructive">
                          {isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                          Confirm reject
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                This recommendation has already been {recommendation.status}.
              </p>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
