'use client';

import { ChevronDown, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

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
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Textarea } from '~/components/ui/textarea';
import {
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
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={`title-${candidate.id}`}>Betco title</Label>
                  <Input
                    id={`title-${candidate.id}`}
                    onChange={(e) => setBetcoTitle(e.target.value)}
                    value={betcoTitle}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`key-${candidate.id}`}>Betco product key</Label>
                  <Input
                    id={`key-${candidate.id}`}
                    onChange={(e) => setBetcoProductKey(e.target.value)}
                    value={betcoProductKey}
                  />
                </div>
              </div>
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

  function handleVerify() {
    startTransition(async () => {
      try {
        await verifyRecommendation(recommendation.id, { chosenCandidateId });
        toast.success('Recommendation verified');
        router.refresh();
      } catch (err) {
        toast.error(getErrorMessage(err, 'Failed to verify recommendation'));
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
                Select the correct Betco match, then Verify to approve it (or Reject with a reason).
              </p>
              {recommendation.candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">No candidates were retrieved.</p>
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
              <div className="flex flex-wrap gap-2">
                <Button disabled={isPending || !chosenCandidateId} onClick={handleVerify} type="button">
                  {isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                  Verify / approve
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
