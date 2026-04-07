'use client';

import { Bot, Copy, Sparkles, User } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Avatar, AvatarFallback } from '~/components/ui/avatar';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';

import { BEX_SUGGESTIONS } from './constants';
import type { ChatMessage } from './types';

type BexChatMessagesProps = {
  messages: ChatMessage[];
  isTyping: boolean;
  showWelcome: boolean;
  onSuggestion: (text: string) => void;
  onStartEmptyChat?: () => void;
};

function formatTime(ts: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ts));
}

export function BexChatMessages({
  isTyping,
  messages,
  onStartEmptyChat,
  onSuggestion,
  showWelcome,
}: BexChatMessagesProps) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isTyping]);

  async function copyText(content: string) {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      /* ignore */
    }
  }

  if (showWelcome && messages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 overflow-y-auto px-6 py-10">
        <div className="flex max-w-lg flex-col items-center text-center">
          <div className="flex size-14 items-center justify-center rounded-3xl bg-primary/10 text-primary">
            <Sparkles className="size-7" aria-hidden />
          </div>
          <h1 className="mt-6 text-2xl font-semibold tracking-tight text-foreground">
            Bex assistant
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            The orchestrator runs the <code className="text-xs">bex-chat</code>{' '}
            workflow, routes to the <strong>Product</strong> or{' '}
            <strong>Bathroom</strong> SME from your wording, and the reply shows
            routing scores plus an acknowledgement from the selected SME (stubs for
            now).
          </p>
          <Badge className="mt-4 rounded-full" variant="secondary">
            Admin · orchestrator · local chat history
          </Badge>
          {onStartEmptyChat ? (
            <Button
              className="mt-6 rounded-2xl"
              onClick={onStartEmptyChat}
              type="button"
              variant="outline"
            >
              Start empty chat
            </Button>
          ) : null}
        </div>

        <div className="w-full max-w-xl space-y-3">
          <p className="text-center text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
            Try asking
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {BEX_SUGGESTIONS.map((text) => (
              <Button
                className="h-auto min-h-11 justify-start whitespace-normal rounded-2xl px-4 py-3 text-left text-sm font-normal leading-snug"
                key={text}
                onClick={() => onSuggestion(text)}
                type="button"
                variant="outline"
              >
                {text}
              </Button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        {messages.map((m) => {
          const isUser = m.role === 'user';

          return (
            <div
              className={cn(
                'flex gap-3',
                isUser ? 'flex-row-reverse' : 'flex-row',
              )}
              key={m.id}
            >
              <Avatar className="mt-0.5 size-9 shrink-0">
                <AvatarFallback
                  className={cn(
                    'text-xs font-medium',
                    isUser
                      ? 'bg-primary/15 text-primary'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  {isUser ? (
                    <User className="size-4" />
                  ) : (
                    <Bot className="size-4" />
                  )}
                </AvatarFallback>
              </Avatar>

              <div
                className={cn(
                  'min-w-0 max-w-[min(100%,36rem)] rounded-3xl px-4 py-3 text-sm leading-relaxed shadow-sm ring-1 ring-border/60',
                  isUser
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-card text-card-foreground',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-medium opacity-80">
                    {isUser ? 'You' : 'Bex'}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 text-xs opacity-70',
                      isUser && 'text-primary-foreground/80',
                    )}
                  >
                    {formatTime(m.createdAt)}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words">
                  {m.content}
                </p>
                {!isUser ? (
                  <div className="mt-3 flex justify-end border-t border-border/40 pt-2">
                    <Button
                      aria-label="Copy message"
                      className="h-8 rounded-xl text-xs"
                      onClick={() => copyText(m.content)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <Copy className="size-3.5" />
                      Copy
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}

        {isTyping ? (
          <div className="flex gap-3">
            <Avatar className="size-9 shrink-0">
              <AvatarFallback className="bg-muted text-muted-foreground">
                <Bot className="size-4" />
              </AvatarFallback>
            </Avatar>
            <div className="rounded-3xl bg-muted/80 px-4 py-3 ring-1 ring-border/50">
              <div className="flex gap-1.5" aria-label="Bex is typing">
                <span className="size-2 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-0.2s]" />
                <span className="size-2 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-0.1s]" />
                <span className="size-2 animate-bounce rounded-full bg-muted-foreground/50" />
              </div>
            </div>
          </div>
        ) : null}

        <div ref={endRef} />
      </div>
    </div>
  );
}
