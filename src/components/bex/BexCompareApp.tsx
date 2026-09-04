'use client';

import { CheckCircle2, GitCompareArrows } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Streamdown } from 'streamdown';
import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';

import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { LabeledCombobox, type LabeledComboboxOption } from '~/components/ui/labeled-combobox';
import { apiFetchConversation, apiListConversations } from '~/lib/bex/bex-api-client';
import { mapApiMessageToChatMessage } from '~/lib/bex/map-api-messages';
import { cn, getErrorMessage } from '~/lib/utils';
import type { ChatMessage } from '~/types/bex';

const streamdownPlugins = { cjk, code, math, mermaid };

type ConversationListItem = Awaited<ReturnType<typeof apiListConversations>>[number];
type ConversationOwner = ConversationListItem['owner'];
type LoadedThread = { id: string; title: string; messages: ChatMessage[] };
type Side = 'A' | 'B';

// B0-840 — human-readable label for the conversation-list "Search by title" comboboxes below.
function ownerLabel(owner: ConversationOwner): string {
  if (!owner) {
    return '';
  }
  if (owner === 'admin') {
    return 'Admin';
  }
  if ('kind' in owner) {
    return `Test: ${owner.title}`;
  }
  return owner.name;
}

function conversationOptionDescription(c: ConversationListItem): string {
  const parts = [new Date(c.updatedAt).toLocaleString(), ownerLabel(c.owner)].filter(Boolean);
  return parts.join(' · ');
}

function toComboboxOption(c: ConversationListItem): LabeledComboboxOption {
  return { id: c.id, label: c.title, description: conversationOptionDescription(c) };
}

function lastAssistant(messages: ChatMessage[]): ChatMessage | undefined {
  return [...messages].reverse().find((m) => m.role === 'assistant');
}

function firstUserPrompt(messages: ChatMessage[]): string {
  return messages.find((m) => m.role === 'user')?.content?.trim() ?? '—';
}

function signals(messages: ChatMessage[]) {
  const assistant = lastAssistant(messages);
  return {
    answer: assistant?.content?.trim() ?? '',
    model: assistant?.meta?.model ?? null,
    confidence: assistant?.meta?.confidence ?? null,
    approved: assistant?.meta?.validation?.approved ?? null,
    tools: (assistant?.meta?.toolSummary ?? []).map((t) => t.name),
    sources: (assistant?.meta?.sources ?? []).map((s) => s.title),
    messageCount: messages.length,
  };
}

type DiffRow = { label: string; a: string; b: string; differ: boolean };

function diffThreads(a: LoadedThread, b: LoadedThread): DiffRow[] {
  const sa = signals(a.messages);
  const sb = signals(b.messages);
  const approvedLabel = (v: boolean | null) =>
    v === null ? '—' : v ? 'approved' : 'not approved';
  const rows: DiffRow[] = [
    { label: 'First user prompt', a: firstUserPrompt(a.messages), b: firstUserPrompt(b.messages) },
    { label: 'Model', a: sa.model ?? '—', b: sb.model ?? '—' },
    {
      label: 'Confidence',
      a: sa.confidence?.toFixed(2) ?? '—',
      b: sb.confidence?.toFixed(2) ?? '—',
    },
    { label: 'Validation', a: approvedLabel(sa.approved), b: approvedLabel(sb.approved) },
    { label: 'Tools used', a: sa.tools.join(', ') || '—', b: sb.tools.join(', ') || '—' },
    { label: 'Sources', a: sa.sources.join(' | ') || '—', b: sb.sources.join(' | ') || '—' },
    { label: 'Message count', a: String(sa.messageCount), b: String(sb.messageCount) },
    { label: 'Final answer', a: sa.answer || '—', b: sb.answer || '—' },
  ].map((row) => ({ ...row, differ: row.a !== row.b }));
  return rows;
}

function readStoredVerdict(key: string): Side | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const stored = window.localStorage.getItem(key);
  return stored === 'A' || stored === 'B' ? stored : null;
}


export function BexCompareApp() {
  const [list, setList] = useState<ConversationListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [idA, setIdA] = useState<string | null>(null);
  const [idB, setIdB] = useState<string | null>(null);
  const [threadA, setThreadA] = useState<LoadedThread | null>(null);
  const [threadB, setThreadB] = useState<LoadedThread | null>(null);
  const [verdictOverrides, setVerdictOverrides] = useState<Record<string, Side>>({});

  useEffect(() => {
    let active = true;
    apiListConversations()
      .then((conversations) => {
        if (active) {
          setList(conversations);
        }
      })
      .catch((err) => {
        if (active) {
          setError(getErrorMessage(err));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const loadThread = useCallback(async (id: string): Promise<LoadedThread> => {
    const detail = await apiFetchConversation(id);
    return {
      id: detail.conversation.id,
      title: detail.conversation.title,
      messages: detail.messages.map(mapApiMessageToChatMessage),
    };
  }, []);

  useEffect(() => {
    if (!idA) {
      return;
    }
    let active = true;
    loadThread(idA)
      .then((thread) => active && setThreadA(thread))
      .catch((err) => active && setError(getErrorMessage(err)));
    return () => {
      active = false;
    };
  }, [idA, loadThread]);

  useEffect(() => {
    if (!idB) {
      return;
    }
    let active = true;
    loadThread(idB)
      .then((thread) => active && setThreadB(thread))
      .catch((err) => active && setError(getErrorMessage(err)));
    return () => {
      active = false;
    };
  }, [idB, loadThread]);

  // Show a loaded thread only when it matches the current selection (the effect no longer
  // clears state synchronously, so guard against a stale thread lingering after a switch).
  const resolvedA = idA && threadA?.id === idA ? threadA : null;
  const resolvedB = idB && threadB?.id === idB ? threadB : null;

  // Verdict is per thread-pair, derived during render (verdictKey is null until two threads
  // are selected, so this stays hydration-safe). Client-only (localStorage) for now; a
  // server-side store (shared, queryable for golden sets) is a documented follow-up.
  const verdictKey = idA && idB ? `bex-compare-verdict:${idA}|${idB}` : null;
  const verdict: Side | null = verdictKey
    ? (verdictOverrides[verdictKey] ?? readStoredVerdict(verdictKey))
    : null;

  const markCorrect = useCallback(
    (side: Side) => {
      if (!verdictKey) {
        return;
      }
      window.localStorage.setItem(verdictKey, side);
      setVerdictOverrides((prev) => ({ ...prev, [verdictKey]: side }));
    },
    [verdictKey],
  );

  const diff = useMemo(
    () => (resolvedA && resolvedB ? diffThreads(resolvedA, resolvedB) : []),
    [resolvedA, resolvedB],
  );
  const differences = diff.filter((row) => row.differ);

  const options = (excludeId: string | null) =>
    list.filter((c) => c.id !== excludeId).map(toComboboxOption);

  return (
    <main className="flex min-h-0 flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <GitCompareArrows className="size-5" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">Bex tools</p>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Compare conversations
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Load up to two threads to see what differed — inputs, model, tools, sources,
            validation, and final answer — and mark the one you consider correct.
          </p>
        </div>
      </div>

      {error ? (
        <p className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {(['A', 'B'] as const).map((side) => {
          const value = side === 'A' ? idA : idB;
          const setValue = side === 'A' ? setIdA : setIdB;
          const otherId = side === 'A' ? idB : idA;
          return (
            <div className="flex items-center gap-2" key={side}>
              <span className="w-16 shrink-0 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Thread {side}
              </span>
              <LabeledCombobox
                className="flex-1 bg-muted/40"
                emptyText="No conversation matches that search."
                onValueChange={setValue}
                options={options(otherId)}
                placeholder="Select a conversation"
                searchPlaceholder="Search by title…"
                value={value}
              />
            </div>
          );
        })}
      </div>

      {resolvedA && resolvedB ? (
        <div className="rounded-2xl border border-border/60 bg-muted/30 p-4">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Difference analysis</h2>
            <Badge className="rounded-full" variant={differences.length ? 'secondary' : 'outline'}>
              {differences.length} of {diff.length} attributes differ
            </Badge>
            {verdict ? (
              <Badge className="rounded-full" variant="default">
                Thread {verdict} marked correct
              </Badge>
            ) : null}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-160 border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-[0.12em] text-muted-foreground">
                  <th className="w-40 p-2">Attribute</th>
                  <th className="p-2">Thread A</th>
                  <th className="p-2">Thread B</th>
                </tr>
              </thead>
              <tbody>
                {diff.map((row) => {
                  const isMarkdownRow = row.label === 'Final answer';
                  return (
                    <tr
                      className={cn('border-t border-border/50 align-top', row.differ && 'bg-amber-500/5')}
                      key={row.label}
                    >
                      <td className="p-2 font-medium text-foreground">
                        {row.label}
                        {row.differ ? (
                          <span className="ml-1 text-amber-600 dark:text-amber-400">•</span>
                        ) : null}
                      </td>
                      <td className={cn('p-2 text-muted-foreground', !isMarkdownRow && 'whitespace-pre-wrap wrap-break-word')}>
                        {isMarkdownRow ? (
                          <Streamdown
                            className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                            plugins={streamdownPlugins}
                          >
                            {row.a || '—'}
                          </Streamdown>
                        ) : (
                          row.a
                        )}
                      </td>
                      <td className={cn('p-2 text-muted-foreground', !isMarkdownRow && 'whitespace-pre-wrap wrap-break-word')}>
                        {isMarkdownRow ? (
                          <Streamdown
                            className="size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                            plugins={streamdownPlugins}
                          >
                            {row.b || '—'}
                          </Streamdown>
                        ) : (
                          row.b
                        )}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t border-border/50">
                  <td className="p-2"></td>
                  <td className="p-2">
                    <Button
                      className="w-full rounded-lg"
                      disabled={!resolvedA}
                      onClick={() => markCorrect('A')}
                      size="sm"
                      type="button"
                      variant={verdict === 'A' ? 'default' : 'outline'}
                    >
                      <CheckCircle2 className="mr-2 size-4" />
                      {verdict === 'A' ? 'Marked correct' : 'Mark correct'}
                    </Button>
                  </td>
                  <td className="p-2">
                    <Button
                      className="w-full rounded-lg"
                      disabled={!resolvedB}
                      onClick={() => markCorrect('B')}
                      size="sm"
                      type="button"
                      variant={verdict === 'B' ? 'default' : 'outline'}
                    >
                      <CheckCircle2 className="mr-2 size-4" />
                      {verdict === 'B' ? 'Marked correct' : 'Mark correct'}
                    </Button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </main>
  );
}
