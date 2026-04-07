'use client';

import { Menu, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';

import { BexChatComposer } from '~/components/bex/BexChatComposer';
import { BexChatMessages } from '~/components/bex/BexChatMessages';
import { BexChatSidebar } from '~/components/bex/BexChatSidebar';
import { BEX_SUGGESTIONS } from '~/lib/bex/constants';
import { callBexOrchestrate } from '~/lib/bex/orchestrator-client';
import {
  createConversation,
  loadSessions,
  saveSessions,
} from '~/lib/bex/sessions';
import type { ChatMessage, Conversation } from '~/types/bex';

export function BexChatApp() {
  const [hydrated, setHydrated] = useState(false);
  const [sessions, setSessions] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sidebarFilter, setSidebarFilter] = useState('');
  const [draft, setDraft] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [model, setModel] = useState('preview');

  useEffect(() => {
    const loaded = loadSessions();
    setSessions(loaded);
    if (loaded.length > 0) {
      setActiveId(loaded[0]!.id);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveSessions(sessions);
  }, [sessions, hydrated]);

  useEffect(() => {
    if (activeId === null) return;
    if (!sessions.some((s) => s.id === activeId)) {
      setActiveId(sessions[0]?.id ?? null);
    }
  }, [sessions, activeId]);

  const activeConversation = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  );

  const messages = activeConversation?.messages ?? [];

  const appendMessages = useCallback(
    (convId: string, additions: ChatMessage[]) => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== convId) return s;
          return {
            ...s,
            messages: [...s.messages, ...additions],
            updatedAt: Date.now(),
          };
        }),
      );
    },
    [],
  );

  const appendUserMessage = useCallback((convId: string, text: string) => {
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      createdAt: Date.now(),
    };

    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== convId) return s;
        const nextMsgs = [...s.messages, userMsg];
        const title =
          s.messages.length === 0
            ? `${text.trim().slice(0, 56)}${text.length > 56 ? '…' : ''}` ||
              'New conversation'
            : s.title;

        return {
          ...s,
          messages: nextMsgs,
          title,
          updatedAt: Date.now(),
        };
      }),
    );
  }, []);

  const sendUserText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isTyping) return;

      let convId = activeId;
      if (!convId) {
        const c = createConversation();
        setSessions((prev) => [c, ...prev]);
        setActiveId(c.id);
        convId = c.id;
      }

      appendUserMessage(convId, trimmed);
      setDraft('');
      setIsTyping(true);

      try {
        const replyText = await callBexOrchestrate({
          message: trimmed,
          model,
        });
        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: replyText,
          createdAt: Date.now(),
        };
        appendMessages(convId, [assistantMsg]);
      } catch (err) {
        const detail =
          err instanceof Error ? err.message : 'Orchestrator request failed.';
        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `**Could not run orchestrator**\n\n${detail}`,
          createdAt: Date.now(),
        };
        appendMessages(convId, [assistantMsg]);
      } finally {
        setIsTyping(false);
      }
    },
    [activeId, appendMessages, appendUserMessage, isTyping, model],
  );

  const handleNewChat = useCallback(() => {
    const c = createConversation();
    setSessions((prev) => [c, ...prev]);
    setActiveId(c.id);
    setMobileSidebarOpen(false);
    setDraft('');
  }, []);

  const handleDelete = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const showFullWelcome = activeId === null;

  return (
    <main className="box-border flex min-h-0 h-full flex-1 flex-col p-4 sm:p-6">
      <div
        className={cn(
          'relative flex min-h-[min(100%,calc(100dvh-8.5rem))] flex-1 overflow-hidden rounded-3xl border border-border/60 bg-background shadow-sm',
          'max-h-[calc(100dvh-8.5rem)]',
        )}
      >
        {mobileSidebarOpen ? (
          <button
            aria-label="Close conversation list"
            className="absolute inset-0 z-30 bg-black/40 lg:hidden"
            onClick={() => setMobileSidebarOpen(false)}
            type="button"
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
            onNewChat={handleNewChat}
            onSelect={setActiveId}
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
                  Orchestrator ·{' '}
                  {model === 'preview'
                    ? 'default model tag'
                    : `model: ${model}`}
                </p>
              </div>
            </div>

            <div className="flex w-full items-center gap-2 sm:w-auto">
              <label className="sr-only" htmlFor="bex-model">
                Model
              </label>
              <select
                className="h-9 w-full min-w-[10rem] rounded-2xl border border-border/60 bg-muted/40 px-3 text-sm outline-none transition focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 sm:w-auto"
                id="bex-model"
                onChange={(e) => setModel(e.target.value)}
                value={model}
              >
                <option value="preview">Model: preview</option>
                <option value="gpt-4o">gpt-4o (planned)</option>
                <option value="gpt-4.1">gpt-4.1 (planned)</option>
                <option value="custom">Custom endpoint (planned)</option>
              </select>
            </div>
          </header>

          <BexChatMessages
            isTyping={isTyping}
            messages={messages}
            onStartEmptyChat={handleNewChat}
            onSuggestion={(text: string) => {
              void sendUserText(text);
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
              value={draft}
            />
          ) : null}
        </section>
      </div>
    </main>
  );
}
