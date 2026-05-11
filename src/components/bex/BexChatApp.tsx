'use client';

import { Menu, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '~/components/ui/button';
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { cn, getErrorMessage } from '~/lib/utils';

import { BexChatComposer } from '~/components/bex/BexChatComposer';
import { BexChatMessages } from '~/components/bex/BexChatMessages';
import { BexChatSidebar } from '~/components/bex/BexChatSidebar';
import {
  DEFAULT_BEX_CHAT_AGENT_MODE,
  isBexChatAgentMode,
  type BexChatAgentMode,
} from '~/lib/agents/agent-registry';
import {
  apiCreateConversation,
  apiDeleteConversation,
  apiFetchConversation,
  apiListConversations,
  apiPostBexChatStream,
  apiSubmitMessageFeedback,
} from '~/lib/bex/bex-api-client';
import { mapApiMessageToChatMessage } from '~/lib/bex/map-api-messages';
import { loadUiCache, saveUiCache } from '~/lib/bex/sessions';
import { BEX_SUGGESTIONS } from '~/lib/bex/constants';
import type { ChatMessage, Conversation } from '~/types/bex';

const STREAMING_ROLLOUT_COHORT =
  process.env.NEXT_PUBLIC_BEX_STREAMING_ROLLOUT_COHORT ?? 'default';

function toMillis(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
}

function makeOptimisticMessage(content: string): ChatMessage {
  const now = Date.now();
  return {
    id: `local-user-${now}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content,
    createdAt: now,
  };
}

export function BexChatApp() {
  const [hydrated, setHydrated] = useState(false);
  const [sessions, setSessions] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarFilter, setSidebarFilter] = useState('');
  const [draft, setDraft] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [model, setModel] = useState('preview');
  const [useValidator, setUseValidator] = useState(false);
  const [agentMode, setAgentMode] = useState<BexChatAgentMode>(
    DEFAULT_BEX_CHAT_AGENT_MODE,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedbackSubmittingMessageId, setFeedbackSubmittingMessageId] = useState<string | null>(
    null,
  );
  const [streamingAssistantText, setStreamingAssistantText] = useState('');
  const [lastStreamMetrics, setLastStreamMetrics] = useState<{
    totalMs: number;
    timeToFirstTokenMs: number | null;
    deltaCount: number;
    usedFallbackChunking: boolean;
  } | null>(null);
  const streamDeltaBufferRef = useRef('');
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushStreamingDeltaBuffer = useCallback(() => {
    const buffered = streamDeltaBufferRef.current;
    streamDeltaBufferRef.current = '';
    if (!buffered) {
      return;
    }
    setStreamingAssistantText((prev) => prev + buffered);
  }, []);

  const queueStreamingDelta = useCallback(
    (delta: string) => {
      streamDeltaBufferRef.current += delta;
      if (streamFlushTimerRef.current !== null) {
        return;
      }
      streamFlushTimerRef.current = setTimeout(() => {
        streamFlushTimerRef.current = null;
        flushStreamingDeltaBuffer();
      }, 32);
    },
    [flushStreamingDeltaBuffer],
  );

  const refreshConversation = useCallback(async (id: string) => {
    const detail = await apiFetchConversation(id);
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== id) {
          return s;
        }
        return {
          ...s,
          title: detail.conversation.title,
          updatedAt: toMillis(detail.conversation.updatedAt),
          messages: detail.messages.map(mapApiMessageToChatMessage),
        };
      }),
    );
  }, []);

  useEffect(() => {
    const cache = loadUiCache();
    setModel(cache.model);
    setUseValidator(cache.useValidator);
    setAgentMode(cache.agentMode);

    void (async () => {
      try {
        const list = await apiListConversations();
        const mapped: Conversation[] = list.map((row) => ({
          id: row.id,
          title: row.title,
          updatedAt: toMillis(row.updatedAt),
          messages: [],
        }));
        setSessions(mapped);

        const preferred = cache.lastActiveConversationId;
        const pick =
          preferred && mapped.some((c) => c.id === preferred)
            ? preferred
            : mapped[0]?.id ?? null;
        setActiveId(pick);

        if (pick) {
          await refreshConversation(pick);
        }
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : 'Failed to load conversations.');
      } finally {
        setHydrated(true);
      }
    })();
  }, [refreshConversation]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    saveUiCache({
      lastActiveConversationId: activeId,
      model,
      useValidator,
      agentMode,
    });
  }, [activeId, hydrated, model, useValidator, agentMode]);

  useEffect(() => {
    if (activeId === null) {
      return;
    }
    if (!sessions.some((s) => s.id === activeId)) {
      setActiveId(sessions[0]?.id ?? null);
    }
  }, [sessions, activeId]);

  const activeConversation = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  );

  const messages = activeConversation?.messages ?? [];
  const renderedMessages = useMemo<ChatMessage[]>(() => {
    if (!isTyping || !streamingAssistantText.trim()) {
      return messages;
    }

    return [
      ...messages,
      {
        id: '__streaming_assistant__',
        role: 'assistant',
        content: streamingAssistantText,
        createdAt: Date.now(),
      },
    ];
  }, [isTyping, messages, streamingAssistantText]);

  const sendUserText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isTyping) {
        return;
      }

      setIsTyping(true);
      setLoadError(null);
      setStreamingAssistantText('');
      setLastStreamMetrics(null);
      streamDeltaBufferRef.current = '';
      if (streamFlushTimerRef.current !== null) {
        clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }

      const optimisticUserMessage = makeOptimisticMessage(trimmed);
      const localConversationId = `local-conv-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      let convId = activeId;
      let startedWithLocalConversation = false;

      if (convId) {
        setSessions((prev) =>
          prev.map((conversation) =>
            conversation.id === convId
              ? {
                  ...conversation,
                  updatedAt: Date.now(),
                  messages: [...conversation.messages, optimisticUserMessage],
                }
              : conversation,
          ),
        );
      } else {
        convId = localConversationId;
        startedWithLocalConversation = true;
        setSessions((prev) => [
          {
            id: localConversationId,
            title: 'New conversation',
            updatedAt: Date.now(),
            messages: [optimisticUserMessage],
          },
          ...prev,
        ]);
        setActiveId(localConversationId);
      }

      try {
        if (!convId || startedWithLocalConversation) {
          const createdConversationId = await apiCreateConversation();
          const previousConvId = convId;
          convId = createdConversationId;
          setSessions((prev) =>
            prev.map((conversation) =>
              conversation.id === previousConvId
                ? {
                    ...conversation,
                    id: createdConversationId,
                    updatedAt: Date.now(),
                  }
                : conversation,
            ),
          );
          setActiveId(createdConversationId);
        }

        const reply = await apiPostBexChatStream({
          conversationId: convId,
          message: trimmed,
          model,
          useValidator,
          agentMode,
          onTextDelta: (delta) => {
            queueStreamingDelta(delta);
          },
        });

        const detail = await apiFetchConversation(reply.conversationId);
        flushStreamingDeltaBuffer();
        if ('streamMetrics' in reply && reply.streamMetrics) {
          setLastStreamMetrics(reply.streamMetrics);
        }
        setActiveId(reply.conversationId);
        setSessions((prev) => {
          const others = prev.filter((c) => c.id !== detail.conversation.id);
          return [
            {
              id: detail.conversation.id,
              title: detail.conversation.title,
              updatedAt: toMillis(detail.conversation.updatedAt),
              messages: detail.messages.map(mapApiMessageToChatMessage),
            },
            ...others,
          ];
        });
      } catch (err) {
        const detail =
          getErrorMessage(err, 'Chat request failed.');
        setLoadError(detail);
        if (convId) {
          if (convId.startsWith('local-conv-')) {
            setSessions((prev) => prev.filter((conversation) => conversation.id !== convId));
            setActiveId((prev) => (prev === convId ? null : prev));
          } else {
            try {
              await refreshConversation(convId);
            } catch {
              /* ignore */
            }
          }
        }
      } finally {
        if (streamFlushTimerRef.current !== null) {
          clearTimeout(streamFlushTimerRef.current);
          streamFlushTimerRef.current = null;
        }
        streamDeltaBufferRef.current = '';
        setIsTyping(false);
        setStreamingAssistantText('');
      }
    },
    [
      activeId,
      agentMode,
      flushStreamingDeltaBuffer,
      isTyping,
      model,
      queueStreamingDelta,
      refreshConversation,
      useValidator,
    ],
  );

  const handleNewChat = useCallback(async () => {
    setMobileSidebarOpen(false);
    setDraft('');
    setLoadError(null);
    try {
      const id = await apiCreateConversation();
      setSessions((prev) => [
        {
          id,
          title: 'New conversation',
          updatedAt: Date.now(),
          messages: [],
        },
        ...prev.filter((s) => s.id !== id),
      ]);
      setActiveId(id);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not start chat.');
    }
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await apiDeleteConversation(id);
        const list = await apiListConversations();
        const nextActive = activeId === id ? (list[0]?.id ?? null) : activeId;
        setActiveId(nextActive);
        setSessions(
          list.map((row) => ({
            id: row.id,
            title: row.title,
            updatedAt: toMillis(row.updatedAt),
            messages: [],
          })),
        );
        if (nextActive) {
          await refreshConversation(nextActive);
        }
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : 'Delete failed.');
      }
    },
    [activeId, refreshConversation],
  );

  const showFullWelcome = activeId === null;
  const handleSubmitFeedback = useCallback(
    async (input: {
      messageId: string;
      rating: 'up' | 'down';
      reasonCode?: string;
      comment?: string;
    }) => {
      if (!activeId) {
        return;
      }
      setFeedbackSubmittingMessageId(input.messageId);
      setLoadError(null);
      try {
        await apiSubmitMessageFeedback(input);
        await refreshConversation(activeId);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : 'Could not save feedback.');
      } finally {
        setFeedbackSubmittingMessageId(null);
      }
    },
    [activeId, refreshConversation],
  );

  const headerSubtitle = activeConversation
    ? `${activeConversation.messages.length ? 'Supabase-backed' : 'Empty thread'} · ${activeConversation.title === 'New conversation' ? 'new' : 'saved'}`
    : 'Select or start a conversation';

  return (
    <main className="box-border flex min-h-0 h-full flex-1 flex-col p-4 sm:p-6">
      {loadError ? (
        <p className="mb-2 text-center text-sm text-destructive">{loadError}</p>
      ) : null}
      <div
        className={cn(
          'relative flex min-h-[min(100%,calc(100dvh-8.5rem))] flex-1 overflow-hidden rounded-3xl border border-border/60 bg-background shadow-sm',
          'max-h-[calc(100dvh-8.5rem)]',
        )}
      >
        {mobileSidebarOpen ? (
          <Button
            aria-label="Close conversation list"
            className="absolute inset-0 z-30 h-full w-full rounded-none bg-black/40 lg:hidden"
            onClick={() => setMobileSidebarOpen(false)}
            size="sm"
            type="button"
            variant="ghost"
          />
        ) : null}

        <div
          className={cn(
            'absolute inset-y-0 left-0 z-40 flex w-[280px] max-w-[min(280px,88vw)] transition-transform duration-200 ease-out lg:relative lg:z-0 lg:max-w-none lg:translate-x-0',
            mobileSidebarOpen
              ? 'translate-x-0'
              : '-translate-x-full lg:translate-x-0',
          )}
        >
          <BexChatSidebar
            activeId={activeId}
            className="h-full min-h-0"
            conversations={sessions}
            filter={sidebarFilter}
            onCloseMobile={() => setMobileSidebarOpen(false)}
            onDelete={handleDelete}
            onFilterChange={setSidebarFilter}
            onNewChat={() => void handleNewChat()}
            onSelect={(id) => {
              setActiveId(id);
              void refreshConversation(id);
            }}
          />
        </div>

        <section
          aria-label="Bex chat"
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <header className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-3 sm:px-5">
            <Button
              aria-label="Open conversation list"
              className="rounded-2xl lg:hidden"
              onClick={() => setMobileSidebarOpen(true)}
              size="icon-sm"
              type="button"
              variant="outline"
            >
              <Menu className="size-4" />
            </Button>

            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Sparkles className="size-4" aria-hidden />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold text-foreground sm:text-base">
                  {activeConversation?.title ?? 'Bex'}
                </h1>
                <p className="truncate text-xs text-muted-foreground">
                  {headerSubtitle}
                  {' · UI tag: '}
                  {model === 'preview' ? 'preview → BEX_RESPONSES_MODEL' : model}
                  {' · transport: '}
                  {`stream (${STREAMING_ROLLOUT_COHORT})`}
                  {' · markdown: '}
                  {'streamdown'}
                  {(() => {
                    const lastModel = [...(activeConversation?.messages ?? [])]
                      .reverse()
                      .find((m) => m.meta?.model)?.meta?.model;
                    return lastModel ? <> · last resolved: {lastModel}</> : null;
                  })()}
                  {isTyping && streamingAssistantText ? (
                    <> · streaming live</>
                  ) : null}
                  {!isTyping && lastStreamMetrics ? (
                    <>
                      {' '}
                      · ttft:{' '}
                      {lastStreamMetrics.timeToFirstTokenMs === null
                        ? 'n/a'
                        : `${lastStreamMetrics.timeToFirstTokenMs}ms`}{' '}
                      · total: {lastStreamMetrics.totalMs}ms
                    </>
                  ) : null}
                </p>
              </div>
            </div>

            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Label className="sr-only" htmlFor="bex-agent-mode">
                Agent mode
              </Label>
              <Select
                onValueChange={(value) => {
                  if (isBexChatAgentMode(value)) {
                    setAgentMode(value);
                  }
                }}
                value={agentMode}
              >
                <SelectTrigger
                  className="w-full min-w-40 bg-muted/40 sm:w-auto"
                id="bex-agent-mode"
                size="default"
              >
                  <SelectValue placeholder="Agent mode" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="orchestrator">Route: orchestrator</SelectItem>
                  <SelectItem value="product">Route: direct product specialist</SelectItem>
                  <SelectItem value="bathroom">Route: direct bathroom specialist</SelectItem>
                  <SelectItem value="dilution">Route: direct dilution specialist</SelectItem>
                  <SelectItem value="floor">Route: direct floor specialist</SelectItem>
                </SelectContent>
              </Select>
              <Label className="sr-only" htmlFor="bex-model">
                Model
              </Label>
              <Select onValueChange={setModel} value={model}>
                <SelectTrigger
                  className="w-full min-w-40 bg-muted/40 sm:w-auto"
                id="bex-model"
                  size="default"
                >
                  <SelectValue placeholder="Model" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="preview">Model: preview (env default)</SelectItem>
                  <SelectItem value="gpt-4o">gpt-4o</SelectItem>
                  <SelectItem value="gpt-4.1">gpt-4.1</SelectItem>
                  <SelectItem value="custom">custom (requires env)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </header>

          <BexChatMessages
            feedbackSubmittingMessageId={feedbackSubmittingMessageId}
            isTyping={isTyping && streamingAssistantText.length === 0}
            messages={renderedMessages}
            onSubmitFeedback={handleSubmitFeedback}
            onStartEmptyChat={() => void handleNewChat()}
            onSuggestion={(t) => {
              void sendUserText(t);
            }}
            showWelcome={showFullWelcome}
          />

          {!showFullWelcome && messages.length === 0 && !isTyping ? (
            <div className="border-t border-border/40 px-4 py-3 sm:px-6">
              <p className="mb-2 text-xs font-medium uppercase tracking-[0.15em] text-muted-foreground">
                Suggested prompts
              </p>
              <div className="flex flex-wrap gap-2">
                {BEX_SUGGESTIONS.map((text) => (
                  <Button
                    className="h-auto rounded-2xl px-3 py-2 text-left text-xs font-normal leading-snug"
                    key={text}
                    onClick={() => void sendUserText(text)}
                    type="button"
                    variant="outline"
                  >
                    {text}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          {!showFullWelcome ? (
            <BexChatComposer
              disabled={isTyping}
              onChange={setDraft}
              onSend={() => void sendUserText(draft)}
              onUseValidatorChange={setUseValidator}
              useValidator={useValidator}
              value={draft}
            />
          ) : null}
        </section>
      </div>
    </main>
  );
}
