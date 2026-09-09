'use client';

import { Check, Copy, Download, Info, Menu, Sparkles } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '~/components/ui/button';
import { Label } from '~/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '~/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { groupModelsByProvider } from '~/lib/llm/provider-label';
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
import { BEX_SUGGESTIONS } from '~/lib/bex/constants';
import { mapApiMessageToChatMessage } from '~/lib/bex/map-api-messages';
import { loadUiCache, saveUiCache } from '~/lib/bex/sessions';
import {
  logBexChatConversationCreated,
  logBexChatConversationDeleted,
  logBexChatConversationExported,
  logBexChatFeedbackSubmitted,
  logBexChatMessageSent,
} from '~/lib/event-logging/bex-events';
import supportedModels, {
  MODEL_DESCRIPTIONS,
  type BexModelTag,
  type SupportedModel,
} from '~/lib/constants/models';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { usePermissionsStore } from '~/lib/stores/permissions';
import type { ChatMessage, Conversation } from '~/types/bex';

function toMillis(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
}

// B0-837 — shared by the mount fetch, the sidebar filter re-fetch, and the "Acting as" re-fetch
// below; all three turn a raw `/api/bex/conversations` row into a sidebar `Conversation` stub
// (transcript loaded separately via `refreshConversation`).
function mapConversationRows(
  rows: Awaited<ReturnType<typeof apiListConversations>>,
): Conversation[] {
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    updatedAt: toMillis(row.updatedAt),
    messages: [],
    owner: row.owner,
    source: row.source,
    isOwner: row.isOwner,
  }));
}

/**
 * B0-693 (part 2) — the route emits `data-bex-event` chunks with `stage: 'request_failed'` for
 * BOTH a pre-stream failure (thrown before any model call) and a mid-stream one (the model call
 * itself threw); either way `runBexChatTurn` never inserted an `agent_messages` row, and the SSE
 * response is still a clean 200 with a closing `data-bex-meta`/`text-end`. `apiPostBexChatStream`
 * forwards this event to `onEvent` if one is passed, but until this fix nothing did, so the event
 * was silently dropped and the turn read as a normal (if empty) success — the reported silent hang.
 *
 * Deliberately narrow: only `type: 'status'` + `stage: 'request_failed'` matches. The payload also
 * carries an `error` field (the raw `Error.message` from the failing workflow run) — NEVER surface
 * that to the user; it can contain provider/credential/internal detail and stays server-side
 * (`workflow_runs.final_output`, Sentry). `BEX_REQUEST_FAILED_MESSAGE` below is the only text shown.
 */
export function isBexRequestFailedEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) {
    return false;
  }
  const record = event as { type?: unknown; stage?: unknown };
  return record.type === 'status' && record.stage === 'request_failed';
}

const BEX_REQUEST_FAILED_MESSAGE =
  "Bex ran into a problem generating a response for that message. It wasn't answered — you can retry below.";

function makeOptimisticMessage(content: string): ChatMessage {
  const now = Date.now();
  return {
    id: `local-user-${now}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content,
    createdAt: now,
  };
}

/**
 * B0-68 — the transitional AI SDK rollout gates are retired, so this component no longer takes
 * server-resolved `settings` values: streaming is the only transport and the AI Elements renderer
 * is unconditional. Nothing here reads the `settings` table any more.
 */
export function BexChatApp() {
  const [hydrated, setHydrated] = useState(false);
  const [sessions, setSessions] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [idCopied, setIdCopied] = useState(false);
  const [sidebarFilter, setSidebarFilter] = useState('');
  // B0-451 — admin-only sidebar filters (source/user); ignored server-side for a non-admin caller
  // regardless of what's sent, so it's harmless to always include them in the list request.
  const [showTestRuns, setShowTestRuns] = useState(false);
  const [userFilterId, setUserFilterId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [model, setModel] = useState('preview');
  const [useValidator, setUseValidator] = useState(false);
  const [agentMode, setAgentMode] = useState<BexChatAgentMode>(
    DEFAULT_BEX_CHAT_AGENT_MODE,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  // B0-693 (part 2) — the exact text of a turn that failed (pre-stream or mid-stream), so the
  // failed-state banner can offer a "Retry" that resends it without the user retyping. Cleared
  // whenever a new send attempt starts and whenever one succeeds.
  const [lastFailedMessage, setLastFailedMessage] = useState<string | null>(null);
  // B0-345: id of the conversation whose history fetch is currently in flight (null = none).
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [feedbackSubmittingMessageId, setFeedbackSubmittingMessageId] =
    useState<string | null>(null);
  const [streamingAssistantText, setStreamingAssistantText] = useState('');
  const [lastStreamMetrics, setLastStreamMetrics] = useState<{
    totalMs: number;
    timeToFirstTokenMs: number | null;
    deltaCount: number;
  } | null>(null);
  const streamDeltaBufferRef = useRef('');
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

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

  // B0-451 — usePermissionsStore has no existing client-side consumer; BexChatApp is the first,
  // and it owns the load() call (mirroring how it already owns sessions/activeId state) rather than
  // having BexChatSidebar import the store itself, so the sidebar stays a plain props-in component.
  const permissionsLoaded = usePermissionsStore((s) => s.loaded);
  const hasPermission = usePermissionsStore((s) => s.hasPermission);
  const isAdminChrome = hasPermission(PERMISSIONS.BEX_CHAT_VIEW_ALL);
  // B0-837 — the effective (acted-as) identity, so the sidebar-refresh effect below can detect
  // an "Acting as" switch. Falls back to email only for parity with how `getUserOrDefault()`
  // itself treats a missing USER_ID; either field flipping means the actor changed.
  const effectiveUserId = usePermissionsStore(
    (s) => s.user?.USER_ID ?? s.user?.EMAIL ?? null,
  );

  /**
   * `?conversationId=` deep link, captured at mount: `useRef`'s initial value is only honored
   * on the first render, so this stays the id the page was opened with even after the user
   * switches threads (which would otherwise re-open the linked thread on every re-render).
   */
  const searchParams = useSearchParams();
  const requestedConversationIdRef = useRef(searchParams.get('conversationId'));

  useEffect(() => {
    if (!permissionsLoaded) {
      void usePermissionsStore.getState().load();
    }
  }, [permissionsLoaded]);

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
          owner: detail.conversation.owner,
          source: detail.conversation.source,
          isOwner: detail.conversation.isOwner,
        };
      }),
    );
  }, []);

  const fetchConversationList = useCallback(
    (filters: { showTestRuns: boolean; userFilter: string | null }) =>
      apiListConversations({
        source: filters.showTestRuns ? undefined : 'chat',
        userFilter: filters.userFilter ?? undefined,
      }),
    [],
  );

  // B0-345: switching threads swaps the title immediately, so flag the fetch and let the
  // message pane show placeholders instead of the previous thread's transcript.
  const selectConversation = useCallback(
    async (id: string) => {
      setActiveId(id);
      setHistoryLoadingId(id);
      try {
        await refreshConversation(id);
      } finally {
        setHistoryLoadingId((prev) => (prev === id ? null : prev));
      }
    },
    [refreshConversation],
  );

  useEffect(() => {
    const cache = loadUiCache();
    setModel(cache.model);
    setUseValidator(cache.useValidator);
    setAgentMode(cache.agentMode);
    setShowTestRuns(cache.showTestRuns);
    setUserFilterId(cache.userFilter);

    void (async () => {
      /**
       * A deep link (`/admin/bex?conversationId=…`, e.g. from a run trace's Conversation
       * field) wins over the cached last-active thread. Resolved here rather than in a
       * follow-up effect because this effect always assigns `activeId` before flipping
       * `hydrated`, so a later effect could only ever fight it.
       */
      const requestedId = requestedConversationIdRef.current;

      try {
        const list = await fetchConversationList({
          showTestRuns: cache.showTestRuns,
          userFilter: cache.userFilter,
        });
        const mapped: Conversation[] = mapConversationRows(list);

        /**
         * The sidebar list is capped (80 rows) and narrowed by the source/user filters, so a
         * deep-linked thread is frequently absent from it. Fetch it by id and splice it in —
         * `activeId` must exist in `sessions` or the reconciling effect below reassigns it.
         */
        let requestedMessages: ChatMessage[] | null = null;
        if (requestedId && !mapped.some((c) => c.id === requestedId)) {
          try {
            const detail = await apiFetchConversation(requestedId);
            requestedMessages = detail.messages.map(mapApiMessageToChatMessage);
            mapped.push({
              id: detail.conversation.id,
              title: detail.conversation.title,
              updatedAt: toMillis(detail.conversation.updatedAt),
              messages: requestedMessages,
              owner: detail.conversation.owner,
              source: detail.conversation.source,
              isOwner: detail.conversation.isOwner,
            });
            mapped.sort((a, b) => b.updatedAt - a.updatedAt);
          } catch (e) {
            // Deleted, or not visible to this actor — say so instead of silently
            // opening an unrelated thread.
            setLoadError(
              `Could not open conversation ${requestedId}: ${getErrorMessage(e)}`,
            );
          }
        }

        setSessions(mapped);

        const preferred =
          requestedId && mapped.some((c) => c.id === requestedId)
            ? requestedId
            : cache.lastActiveConversationId;
        const pick =
          preferred && mapped.some((c) => c.id === preferred)
            ? preferred
            : (mapped[0]?.id ?? null);
        setActiveId(pick);

        // The deep-linked thread arrived with its transcript already attached above.
        if (pick && !(pick === requestedId && requestedMessages)) {
          await refreshConversation(pick);
        }
      } catch (e) {
        setLoadError(
          e instanceof Error ? e.message : 'Failed to load conversations.',
        );
      } finally {
        setHydrated(true);
      }
    })();
  }, [fetchConversationList, refreshConversation]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    saveUiCache({
      lastActiveConversationId: activeId,
      model,
      useValidator,
      agentMode,
      showTestRuns,
      userFilter: userFilterId,
    });
  }, [
    activeId,
    hydrated,
    model,
    useValidator,
    agentMode,
    showTestRuns,
    userFilterId,
  ]);

  // B0-451 — re-fetches the list under new filters and updates the sidebar; does not touch
  // messages for the active conversation (a filter change never implies the active thread's
  // transcript changed) — if the active conversation drops out of the new filtered list, the
  // existing "activeId not in sessions" effect below reassigns it.
  const applyConversationFilters = useCallback(
    async (filters: { showTestRuns: boolean; userFilter: string | null }) => {
      try {
        const list = await fetchConversationList(filters);
        const mapped: Conversation[] = mapConversationRows(list);
        setSessions(mapped);
      } catch (e) {
        setLoadError(
          e instanceof Error ? e.message : 'Failed to load conversations.',
        );
      }
    },
    [fetchConversationList],
  );

  // B0-837 — switching "Acting as" (`UserSwitcherClient`) updates `usePermissionsStore`'s
  // effective user via `router.refresh()` + `/api/me`, but nothing in this component's own
  // `sessions`/`activeId` state depended on that identity, so the sidebar kept showing the
  // previous actor's conversations until a manual reload. Re-fetches under the current filters
  // once the effective user changes after the initial hydration has already picked a baseline.
  const effectiveUserBaselineRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!permissionsLoaded) {
      return;
    }
    if (effectiveUserBaselineRef.current === undefined) {
      // First resolved identity — matches whatever the initial mount fetch already used.
      effectiveUserBaselineRef.current = effectiveUserId;
      return;
    }
    if (effectiveUserBaselineRef.current === effectiveUserId) {
      return;
    }
    effectiveUserBaselineRef.current = effectiveUserId;
    if (!hydrated) {
      return;
    }

    setSessions([]);
    setActiveId(null);

    void (async () => {
      try {
        const list = await fetchConversationList({
          showTestRuns,
          userFilter: userFilterId,
        });
        const mapped = mapConversationRows(list);
        setSessions(mapped);
        const pick = mapped[0]?.id ?? null;
        setActiveId(pick);
        if (pick) {
          await refreshConversation(pick);
        }
      } catch (e) {
        setLoadError(
          e instanceof Error ? e.message : 'Failed to load conversations.',
        );
      }
    })();
  }, [
    effectiveUserId,
    permissionsLoaded,
    hydrated,
    fetchConversationList,
    refreshConversation,
    showTestRuns,
    userFilterId,
  ]);

  const handleShowTestRunsChange = useCallback(
    (value: boolean) => {
      setShowTestRuns(value);
      void applyConversationFilters({
        showTestRuns: value,
        userFilter: userFilterId,
      });
    },
    [applyConversationFilters, userFilterId],
  );

  const handleUserFilterChange = useCallback(
    (value: string | null) => {
      setUserFilterId(value);
      void applyConversationFilters({ showTestRuns, userFilter: value });
    },
    [applyConversationFilters, showTestRuns],
  );

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
      setLastFailedMessage(null);
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
            owner: null,
            source: 'chat',
            isOwner: true,
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
          // B0-761 — analytics tag, fire-and-forget.
          logBexChatConversationCreated({
            conversationId: createdConversationId,
          });
        }

        // B0-761 — prompt length only; the prompt text never leaves as event meta.
        logBexChatMessageSent({
          conversationId: convId,
          promptLength: trimmed.length,
          model,
          agentMode,
          useValidator,
        });

        // B0-693 (part 2) — set from `onEvent` below when the route signals `request_failed`
        // mid-stream. `apiPostBexChatStream` does NOT throw for this case (the response still
        // carries a valid closing `data-bex-meta`), so this is checked explicitly right after the
        // call resolves, below.
        let requestFailedDuringStream = false;
        const reply = await apiPostBexChatStream({
          conversationId: convId,
          message: trimmed,
          model,
          useValidator,
          agentMode,
          onTextDelta: (delta) => {
            queueStreamingDelta(delta);
          },
          onEvent: (event) => {
            if (isBexRequestFailedEvent(event)) {
              requestFailedDuringStream = true;
            }
          },
        });

        if (requestFailedDuringStream) {
          // B0-693 (part 2) — reuses the exact same failure handling as a thrown/network error
          // below (visible banner, retryable, conversation state reconciled from the DB) instead
          // of a second failure path, so the two can never drift out of sync.
          throw new Error(BEX_REQUEST_FAILED_MESSAGE);
        }

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
              owner: detail.conversation.owner,
              source: detail.conversation.source,
              isOwner: detail.conversation.isOwner,
            },
            ...others,
          ];
        });
      } catch (err) {
        const detail = getErrorMessage(err, 'Chat request failed.');
        setLoadError(detail);
        // B0-693 (part 2) — every failure here (this one included) is retryable without retyping:
        // the original text is still known even though the composer's draft was already cleared.
        setLastFailedMessage(trimmed);
        if (convId) {
          if (convId.startsWith('local-conv-')) {
            setSessions((prev) =>
              prev.filter((conversation) => conversation.id !== convId),
            );
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
          owner: null,
          source: 'chat',
          isOwner: true,
        },
        ...prev.filter((s) => s.id !== id),
      ]);
      setActiveId(id);
      // B0-761 — analytics tag, fire-and-forget.
      logBexChatConversationCreated({ conversationId: id });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not start chat.');
    }
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await apiDeleteConversation(id);
        // B0-761 — analytics tag, fire-and-forget.
        logBexChatConversationDeleted({ conversationId: id });
        const list = await fetchConversationList({
          showTestRuns,
          userFilter: userFilterId,
        });
        const nextActive = activeId === id ? (list[0]?.id ?? null) : activeId;
        setActiveId(nextActive);
        setSessions(
          list.map((row) => ({
            id: row.id,
            title: row.title,
            updatedAt: toMillis(row.updatedAt),
            messages: [],
            owner: row.owner,
            source: row.source,
            isOwner: row.isOwner,
          })),
        );
        if (nextActive) {
          await refreshConversation(nextActive);
        }
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : 'Delete failed.');
      }
    },
    [
      activeId,
      fetchConversationList,
      refreshConversation,
      showTestRuns,
      userFilterId,
    ],
  );

  // B0-345: while the initial list/history fetch is running we hold the chat frame and show
  // placeholders; the welcome screen is an "empty after load" state, not a loading state.
  const isLoadingHistory =
    !hydrated || (historyLoadingId !== null && historyLoadingId === activeId);
  const showFullWelcome = hydrated && activeId === null;
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
        // B0-761 — rating + reason code only; `input.comment` is free text and is never logged.
        logBexChatFeedbackSubmitted({
          conversationId: activeId,
          messageId: input.messageId,
          rating: input.rating,
          reasonCode: input.reasonCode,
        });
        await refreshConversation(activeId);
      } catch (error) {
        setLoadError(
          error instanceof Error ? error.message : 'Could not save feedback.',
        );
      } finally {
        setFeedbackSubmittingMessageId(null);
      }
    },
    [activeId, refreshConversation],
  );

  const headerSubtitle = activeConversation
    ? `${activeConversation.messages.length ? 'Supabase-backed' : 'Empty thread'} · ${activeConversation.title === 'New conversation' ? 'new' : 'saved'}`
    : 'Select or start a conversation';

  // B0-61: the thread's unique id, shown once the conversation is saved (not the "New conversation" placeholder).
  const conversationId =
    activeConversation && activeConversation.title !== 'New conversation'
      ? activeConversation.id
      : null;

  const copyConversationId = async () => {
    if (!conversationId) {
      return;
    }
    try {
      await navigator.clipboard.writeText(conversationId);
      setIdCopied(true);
      setTimeout(() => setIdCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  // B0-59: export the active thread as a structured JSON file (every message + assistant metadata).
  const canDownloadConversation = Boolean(
    activeConversation && activeConversation.messages.length > 0,
  );

  const downloadConversationJson = () => {
    if (!activeConversation) {
      return;
    }
    const payload = {
      id: activeConversation.id,
      title: activeConversation.title,
      updatedAt: new Date(activeConversation.updatedAt).toISOString(),
      exportedAt: new Date().toISOString(),
      messageCount: activeConversation.messages.length,
      messages: activeConversation.messages.map((m) => ({
        id: m.id,
        role: m.role,
        createdAt: new Date(m.createdAt).toISOString(),
        content: m.content,
        workflowRunId: m.workflowRunId ?? m.meta?.workflowRunId ?? null,
        model: m.meta?.model ?? null,
        confidence: m.meta?.confidence ?? null,
        sources: m.meta?.sources ?? null,
        toolSummary: m.meta?.toolSummary ?? null,
        validation: m.meta?.validation ?? null,
        feedback: m.feedback ?? null,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `bex-conversation-${activeConversation.id}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    // B0-761 — analytics tag, fire-and-forget.
    logBexChatConversationExported({
      conversationId: activeConversation.id,
      format: 'json',
    });
  };

  return (
    <main className="box-border flex min-h-0 h-full flex-1 flex-col p-4 sm:p-6">
      {loadError ? (
        <div className="mb-2 flex flex-wrap items-center justify-center gap-2">
          <p className="text-center text-sm text-destructive">{loadError}</p>
          {lastFailedMessage ? (
            <Button
              disabled={isTyping}
              onClick={() => void sendUserText(lastFailedMessage)}
              size="sm"
              type="button"
              variant="outline"
            >
              Retry
            </Button>
          ) : null}
        </div>
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
            isAdminChrome={isAdminChrome}
            isLoading={!hydrated}
            onCloseMobile={() => setMobileSidebarOpen(false)}
            onDelete={handleDelete}
            onFilterChange={setSidebarFilter}
            onNewChat={() => void handleNewChat()}
            onSelect={(id) => {
              void selectConversation(id);
            }}
            onShowTestRunsChange={handleShowTestRunsChange}
            onUserFilterChange={handleUserFilterChange}
            showTestRuns={showTestRuns}
            userFilter={userFilterId}
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
                {conversationId && isAdminChrome ? (
                  <button
                    className="mt-0.5 flex min-w-0 max-w-full items-center gap-1 font-mono text-[0.65rem] text-muted-foreground/80 hover:text-foreground"
                    onClick={() => void copyConversationId()}
                    title="Copy conversation ID"
                    type="button"
                  >
                    {idCopied ? (
                      <Check className="size-3 shrink-0" aria-hidden />
                    ) : (
                      <Copy className="size-3 shrink-0" aria-hidden />
                    )}
                    <span className="truncate">{conversationId}</span>
                  </button>
                ) : null}
              </div>
            </div>

            {isAdminChrome ? (
              <div className="flex w-full items-center gap-2 sm:w-auto">
                <Button
                  aria-label="Download conversation as JSON"
                  className="rounded-2xl"
                  disabled={!canDownloadConversation}
                  onClick={downloadConversationJson}
                  size="icon-sm"
                  title="Download conversation (JSON)"
                  type="button"
                  variant="outline"
                >
                  <Download className="size-4" />
                </Button>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      aria-label="Conversation details"
                      className="rounded-2xl"
                      size="icon-sm"
                      title="Conversation details"
                      type="button"
                      variant="outline"
                    >
                      <Info className="size-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    className="w-80 text-xs leading-relaxed"
                  >
                    <p className="text-muted-foreground">
                      {headerSubtitle}
                      {' · UI tag: '}
                      {model === 'preview'
                        ? 'preview → BEX_RESPONSES_MODEL'
                        : model}
                      {' · transport: '}
                      {'stream'}
                      {' · markdown: '}
                      {'streamdown'}
                      {(() => {
                        const lastModel = [
                          ...(activeConversation?.messages ?? []),
                        ]
                          .reverse()
                          .find((m) => m.meta?.model)?.meta?.model;
                        return lastModel ? (
                          <> · last resolved: {lastModel}</>
                        ) : null;
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
                  </PopoverContent>
                </Popover>
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
                    <SelectItem value="orchestrator">Orchestrator</SelectItem>
                    <SelectItem value="product">Product</SelectItem>
                    <SelectItem value="bathroom">Bathroom</SelectItem>
                    <SelectItem value="dilution">Dilution</SelectItem>
                    <SelectItem value="floor_wood_sport">Floor — Wood/Sport</SelectItem>
                    <SelectItem value="floor_concrete">Floor — Concrete</SelectItem>
                    <SelectItem value="floor_stg">Floor — Stone/Tile/Grout</SelectItem>
                    <SelectItem value="floor_vct">Floor — VCT</SelectItem>
                    <SelectItem value="recommendations">
                      Recommendations
                    </SelectItem>
                    <SelectItem value="cross_reference">
                      Cross-Reference
                    </SelectItem>
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
                  {/* B0-905 — grouped by vendor, because the list carries both OpenAI and
                      Anthropic tags since B0-908 and a flat list hid which vendor would answer. */}
                  <SelectContent>
                    <SelectItem value="preview">
                      Model: preview (settings default)
                    </SelectItem>
                    {groupModelsByProvider(supportedModels).map((group) => (
                      <SelectGroup key={group.provider}>
                        <SelectLabel>{group.label}</SelectLabel>
                        {group.models.map((m: SupportedModel) => (
                          <SelectItem key={m.name} value={m.name}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
                {/* B0-602 — what the selected model is and what it costs, so picking one in chat is
                    an informed choice rather than a guess at an opaque tag. */}
                <p className="mt-1 max-w-xs text-xs leading-snug text-muted-foreground">
                  {MODEL_DESCRIPTIONS[model as BexModelTag] ?? null}
                </p>
              </div>
            ) : null}
          </header>

          <BexChatMessages
            feedbackSubmittingMessageId={feedbackSubmittingMessageId}
            isAdminChrome={isAdminChrome}
            isLoadingHistory={isLoadingHistory}
            isTyping={isTyping && streamingAssistantText.length === 0}
            messages={renderedMessages}
            onSubmitFeedback={handleSubmitFeedback}
            onStartEmptyChat={() => void handleNewChat()}
            onSuggestion={(t) => {
              void sendUserText(t);
            }}
            showWelcome={showFullWelcome}
          />

          {!showFullWelcome &&
          !isLoadingHistory &&
          messages.length === 0 &&
          !isTyping ? (
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

          {/* B0-451 — an admin viewing someone else's thread (isOwner: false); a non-admin can
              never even load a foreign conversation (403 from B0-449), so this only ever
              triggers for a view-all admin — no extra permission check needed here. */}
          {!showFullWelcome && activeConversation?.isOwner === false ? (
            <p className="border-t border-border/40 px-4 py-2 text-center text-xs text-muted-foreground sm:px-6">
              Read-only — you&apos;re viewing another user&apos;s conversation.
              Sending is disabled.
            </p>
          ) : null}

          {!showFullWelcome ? (
            <BexChatComposer
              disabled={isTyping || activeConversation?.isOwner === false}
              isAdminChrome={isAdminChrome}
              onChange={setDraft}
              onSend={() => {
                const text = draft;
                setDraft('');
                void sendUserText(text);
              }}
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
