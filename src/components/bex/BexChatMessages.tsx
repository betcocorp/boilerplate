'use client';

import {
  Bot,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  User,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { BexMessagesSkeleton } from '~/components/bex/BexChatSkeleton';
import { BexStreamdown } from '~/components/bex/BexStreamdown';
import { RagDocumentChunkInspectButtons } from '~/components/rag/RagDocumentChunkInspect';
import { Avatar, AvatarFallback } from '~/components/ui/avatar';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Separator } from '~/components/ui/separator';
import { Textarea } from '~/components/ui/textarea';
import { isRagRowId } from '~/lib/rag/document-chunk-types';
import { cn } from '~/lib/utils';

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '~/components/ai-elements/conversation';
import { Message, MessageContent } from '~/components/ai-elements/message';
import { BEX_SUGGESTIONS } from '~/lib/bex/constants';
import type { ChatMessage } from '~/types/bex';

type BexChatMessagesProps = {
  messages: ChatMessage[];
  isTyping: boolean;
  showWelcome: boolean;
  /** B0-345: history for the selected conversation is in flight — render placeholders. */
  isLoadingHistory?: boolean;
  onSuggestion: (text: string) => void;
  onStartEmptyChat?: () => void;
  feedbackSubmittingMessageId?: string | null;
  onSubmitFeedback?: (input: {
    messageId: string;
    rating: 'up' | 'down';
    reasonCode?: string;
    comment?: string;
  }) => Promise<void>;
  /**
   * AISDK-3: gate the AI Elements rendering variant. Default off — the existing custom bubble UI
   * is unchanged until this flag is flipped and visually QA'd. Resolved server-side from the
   * `settings` table (`NEXT_PUBLIC_BEX_AI_ELEMENTS_UI`) and passed down, since a client component
   * cannot read a DB-backed setting itself.
   */
  useAiElements?: boolean;
};

const DOWNVOTE_REASON_OPTIONS = [
  { id: 'wrong_facts', label: 'Wrong facts' },
  { id: 'missing_context', label: 'Missing context' },
  { id: 'unsafe_guidance', label: 'Unsafe guidance' },
  { id: 'bad_tone', label: 'Bad tone' },
  { id: 'other', label: 'Other' },
];

function formatTime(ts: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ts));
}

function AssistantDetails({
  messageId,
  meta,
}: {
  messageId: string;
  meta: NonNullable<ChatMessage['meta']>;
}) {
  const [open, setOpen] = useState(false);
  const hasReasoning =
    meta.confidence !== undefined ||
    !!meta.validation ||
    !!meta.toolSummary?.length ||
    !!meta.workflowRunId;
  const hasSources = !!meta.sources?.length;

  return (
    <div className="mt-2 text-xs text-muted-foreground">
      <Separator className="mb-4 bg-border/40" />
      <Button
        className="h-auto gap-1 px-0 text-xs font-medium text-foreground/80 hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        type="button"
        variant="ghost"
      >
        {open ? (
          <ChevronDown className="size-3.5" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5" aria-hidden />
        )}
        Details
        {hasReasoning ? (
          <Badge
            className="ml-1.5 rounded-full px-1.5 py-0 text-[0.62rem]"
            variant="secondary"
          >
            reasoning
          </Badge>
        ) : null}
        {hasSources ? (
          <Badge
            className="ml-1 rounded-full px-1.5 py-0 text-[0.62rem]"
            variant="secondary"
          >
            sources {meta.sources?.length}
          </Badge>
        ) : null}
      </Button>
      {open ? (
        <div className="mt-2 space-y-2 rounded-xl bg-muted/50 p-3 text-left">
          {meta.workflowRunId ? (
            <p className="font-mono text-[0.65rem] opacity-70">
              Run:{' '}
              <Link
                className="underline decoration-muted-foreground/60 underline-offset-2 transition hover:text-foreground hover:decoration-foreground"
                href={`/admin/observability/${meta.workflowRunId}`}
              >
                {meta.workflowRunId}
              </Link>
              {' · '}
              <Link
                className="underline decoration-muted-foreground/60 underline-offset-2 transition hover:text-foreground hover:decoration-foreground"
                href={`/admin/observability/${meta.workflowRunId}`}
              >
                trace
              </Link>
            </p>
          ) : null}
          {hasReasoning ? (
            <div className="space-y-2 rounded-lg border border-border/60 bg-background/70 p-2.5">
              <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Reasoning
              </p>
              <div className="flex flex-wrap gap-1.5">
                {meta.confidence !== undefined ? (
                  <Badge className="rounded-full" variant="outline">
                    confidence {meta.confidence.toFixed(2)}
                  </Badge>
                ) : null}
                {meta.validation ? (
                  <Badge
                    className="rounded-full"
                    variant={
                      meta.validation.approved ? 'secondary' : 'destructive'
                    }
                  >
                    {meta.validation.approved ? 'validated' : 'not approved'}
                  </Badge>
                ) : null}
                {meta.validation?.requiresHumanReview ? (
                  <Badge className="rounded-full" variant="outline">
                    human review
                  </Badge>
                ) : null}
              </div>
              {meta.validation?.issues && meta.validation.issues.length > 0 ? (
                <div>
                  <p className="font-medium text-foreground">
                    Validation issues
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {meta.validation.issues.map((issue) => (
                      <li key={`${messageId}-${issue}`}>{issue}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {meta.toolSummary && meta.toolSummary.length > 0 ? (
                <div>
                  <p className="font-medium text-foreground">Tool calls</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {meta.toolSummary.map((tool, index) => (
                      <Badge
                        className="rounded-full font-mono text-[0.65rem]"
                        key={`${messageId}-${tool.name}-${index}`}
                        variant={tool.ok ? 'secondary' : 'destructive'}
                      >
                        {tool.name}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {meta.sources && meta.sources.length > 0 ? (
            <div className="space-y-2 rounded-lg border border-border/60 bg-background/70 p-2.5">
              <p className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Sources
              </p>
              <ul className="space-y-2">
                {meta.sources.slice(0, 6).map((s) => {
                  const isExternal = s.kind === 'external' || !!s.url;
                  // Synthetic sources (e.g. structured "Verified Product Facts") have no
                  // rag.document row to inspect — the facts are the snippet itself, so
                  // show it in full and skip the DB-backed inspect buttons.
                  const isFacts = !isExternal && !isRagRowId(s.documentId);
                  return (
                    <li
                      className="wrap-break-word rounded-md border border-border/60 bg-muted/30 p-2"
                      key={`${messageId}-${s.url ?? s.documentId}-${s.chunkId ?? 'chunk'}`}
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        {isExternal && s.url ? (
                          <a
                            className="flex min-w-0 items-center gap-1 font-medium text-foreground hover:underline"
                            href={s.url}
                            rel="noreferrer"
                            target="_blank"
                          >
                            <span className="wrap-break-word">{s.title}</span>
                            <ExternalLink className="size-3 shrink-0 opacity-60" />
                          </a>
                        ) : (
                          <span className="font-medium text-foreground">
                            {s.title}
                          </span>
                        )}
                        {isExternal ? (
                          <Badge
                            className="rounded-full px-1.5 py-0 text-[0.62rem]"
                            variant="secondary"
                          >
                            web
                          </Badge>
                        ) : null}
                        {typeof s.similarity === 'number' ? (
                          <Badge
                            className="rounded-full px-1.5 py-0 text-[0.62rem]"
                            variant="outline"
                          >
                            {(s.similarity * 100).toFixed(0)}%
                          </Badge>
                        ) : null}
                      </div>
                      {s.snippet ? (
                        <p
                          className={cn(
                            'mt-1 text-muted-foreground',
                            isFacts ? 'whitespace-pre-wrap' : 'line-clamp-2',
                          )}
                        >
                          {s.snippet}
                        </p>
                      ) : null}
                      {!isExternal && !isFacts ? (
                        <div className="mt-1 opacity-90">
                          <RagDocumentChunkInspectButtons
                            chunkId={s.chunkId ?? null}
                            documentId={s.documentId}
                            layout="inline"
                            size="xs"
                          />
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {meta.sources.length > 6 ? (
                <p className="text-[0.7rem] opacity-70">
                  +{meta.sources.length - 6} more source
                  {meta.sources.length - 6 === 1 ? '' : 's'}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function BexChatMessageBody({
  content,
  isUser,
  isStreaming,
}: {
  content: string;
  isUser: boolean;
  isStreaming: boolean;
}) {
  return (
    <BexStreamdown
      content={content}
      isStreaming={isStreaming}
      isUser={isUser}
    />
  );
}

// AISDK-3: AI Elements rendering variant (Conversation + Message/MessageContent).
// Reuses the existing markdown body, feedback, details, and copy — only the scroll
// container and bubble shell come from AI Elements. Selected via the `useAiElements` prop.
function BexAiElementsMessages({
  messages,
  isTyping,
  feedbackSubmittingMessageId,
  onSubmitFeedback,
}: Pick<
  BexChatMessagesProps,
  'messages' | 'isTyping' | 'feedbackSubmittingMessageId' | 'onSubmitFeedback'
>) {
  async function copyText(content: string) {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      /* ignore */
    }
  }

  return (
    <Conversation>
      <ConversationContent>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          {messages.map((m, index) => {
            const isUser = m.role === 'user';
            const isMostRecentMessage = index === messages.length - 1;
            const isStreamingPlaceholder = m.id === '__streaming_assistant__';

            return (
              <Message from={m.role} key={m.id}>
                <MessageContent>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium opacity-80">
                      {isUser ? 'You' : 'Bex'}
                    </span>
                    <span className="shrink-0 text-xs opacity-70">
                      {formatTime(m.createdAt)}
                    </span>
                  </div>
                  <BexChatMessageBody
                    content={m.content}
                    isStreaming={
                      !isUser &&
                      (isStreamingPlaceholder ||
                        (isTyping && isMostRecentMessage))
                    }
                    isUser={isUser}
                  />
                  {!isUser && !isStreamingPlaceholder ? (
                    <AssistantFeedbackActions
                      feedback={m.feedback}
                      isSubmitting={feedbackSubmittingMessageId === m.id}
                      messageId={m.id}
                      onSubmitFeedback={onSubmitFeedback}
                    />
                  ) : null}
                  {!isUser && !isStreamingPlaceholder && m.meta ? (
                    <AssistantDetails messageId={m.id} meta={m.meta} />
                  ) : null}
                  {!isUser && !isStreamingPlaceholder ? (
                    <div className="flex justify-end">
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
                </MessageContent>
              </Message>
            );
          })}
          {isTyping ? (
            <Message from="assistant">
              <MessageContent>
                <div className="flex gap-1.5" aria-label="Bex is typing">
                  <span className="size-2 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-0.2s]" />
                  <span className="size-2 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-0.1s]" />
                  <span className="size-2 animate-bounce rounded-full bg-muted-foreground/50" />
                </div>
              </MessageContent>
            </Message>
          ) : null}
        </div>
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

export function BexChatMessages({
  isLoadingHistory = false,
  isTyping,
  messages,
  feedbackSubmittingMessageId,
  onSubmitFeedback,
  onStartEmptyChat,
  onSuggestion,
  showWelcome,
  useAiElements = false,
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

  // B0-345: takes precedence over the welcome/transcript branches so a conversation switch
  // never paints the outgoing thread's messages under the incoming thread's title.
  if (isLoadingHistory) {
    return <BexMessagesSkeleton />;
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
            Bex runs the <code className="text-xs">product-support</code>{' '}
            workflow: OpenAI Responses API with server-side tools over your RAG
            corpus, a validator pass, and durable threads in Supabase.
          </p>
          <Badge className="mt-4 rounded-full" variant="secondary">
            Admin · Responses API · Supabase history
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

  if (useAiElements) {
    return (
      <BexAiElementsMessages
        feedbackSubmittingMessageId={feedbackSubmittingMessageId}
        isTyping={isTyping}
        messages={messages}
        onSubmitFeedback={onSubmitFeedback}
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        {messages.map((m, index) => {
          const isUser = m.role === 'user';
          const isMostRecentMessage = index === messages.length - 1;
          const isStreamingPlaceholder = m.id === '__streaming_assistant__';

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
                  'relative min-w-0 max-w-[min(100%,36rem)] overflow-hidden rounded-3xl px-4 py-3 text-sm leading-relaxed shadow-sm ring-1 ring-border/60',
                  isUser
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-card text-card-foreground',
                )}
              >
                <div
                  aria-hidden
                  className={cn(
                    'pointer-events-none absolute inset-0 rounded-[inherit]',
                    isUser
                      ? 'bg-[linear-gradient(45deg,rgb(0_0_0/0.18),transparent,rgb(255_255_255/0.14))]'
                      : 'bg-[linear-gradient(45deg,rgb(0_0_0/0.025),transparent,rgb(255_255_255/0.4))]',
                  )}
                />
                <div className="relative">
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
                  <BexChatMessageBody
                    content={m.content}
                    isStreaming={
                      !isUser &&
                      (isStreamingPlaceholder ||
                        (isTyping && isMostRecentMessage))
                    }
                    isUser={isUser}
                  />
                  {!isUser && !isStreamingPlaceholder ? (
                    <div className="mt-3">
                      <AssistantFeedbackActions
                        feedback={m.feedback}
                        isSubmitting={feedbackSubmittingMessageId === m.id}
                        messageId={m.id}
                        onSubmitFeedback={onSubmitFeedback}
                      />
                    </div>
                  ) : null}
                  {!isUser && !isStreamingPlaceholder && m.meta ? (
                    <AssistantDetails messageId={m.id} meta={m.meta} />
                  ) : null}
                  {!isUser && !isStreamingPlaceholder && (
                    <div className="mt-3">
                      <Separator className="mb-2 bg-border/40" />
                      <div className="flex justify-end">
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
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {isTyping && (
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
        )}

        <div ref={endRef} />
      </div>
    </div>
  );
}

function AssistantFeedbackActions({
  messageId,
  feedback,
  onSubmitFeedback,
  isSubmitting,
}: {
  messageId: string;
  feedback: ChatMessage['feedback'];
  onSubmitFeedback?: BexChatMessagesProps['onSubmitFeedback'];
  isSubmitting: boolean;
}) {
  const [showDownvoteDialog, setShowDownvoteDialog] = useState(false);
  const [reasonCode, setReasonCode] = useState(
    DOWNVOTE_REASON_OPTIONS[0]?.id || 'other',
  );
  const [comment, setComment] = useState('');

  const submit = async (input: {
    rating: 'up' | 'down';
    reasonCode?: string;
    comment?: string;
  }) => {
    if (!onSubmitFeedback) {
      return;
    }
    await onSubmitFeedback({
      messageId,
      rating: input.rating,
      reasonCode: input.reasonCode,
      comment: input.comment,
    });
  };

  return (
    <div className="mr-auto flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <Button
          aria-label="Thumbs up"
          className={cn(
            'h-8 rounded-xl text-xs',
            feedback?.rating === 'up' && 'text-green-600',
          )}
          disabled={isSubmitting || !onSubmitFeedback}
          onClick={() => void submit({ rating: 'up' })}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ThumbsUp className="size-3.5" />
          Helpful
        </Button>
        <Button
          aria-label="Thumbs down"
          className={cn(
            'h-8 rounded-xl text-xs',
            feedback?.rating === 'down' && 'text-red-600',
          )}
          disabled={isSubmitting || !onSubmitFeedback}
          onClick={() => setShowDownvoteDialog(true)}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ThumbsDown className="size-3.5" />
          Not helpful
        </Button>
      </div>
      <Dialog
        onOpenChange={(open) => {
          setShowDownvoteDialog(open);
        }}
        open={showDownvoteDialog}
      >
        <DialogContent className="gap-4" showCloseButton={false}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit({
                rating: 'down',
                reasonCode,
                comment: comment.trim() || undefined,
              }).then(() => {
                setShowDownvoteDialog(false);
                setComment('');
              });
            }}
          >
            <DialogHeader>
              <DialogTitle id={`feedback-dialog-title-${messageId}`}>
                Why was this not helpful?
              </DialogTitle>
              <DialogDescription>
                Share quick feedback to help improve assistant responses.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor={`feedback-reason-${messageId}`}>Reason</Label>
              <Select onValueChange={setReasonCode} value={reasonCode}>
                <SelectTrigger
                  className="w-full"
                  id={`feedback-reason-${messageId}`}
                >
                  <SelectValue placeholder="Choose a reason" />
                </SelectTrigger>
                <SelectContent>
                  {DOWNVOTE_REASON_OPTIONS.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`feedback-comment-${messageId}`}>
                Optional details
              </Label>
              <Textarea
                id={`feedback-comment-${messageId}`}
                className="min-h-24"
                onChange={(event) => setComment(event.target.value)}
                placeholder="Optional details"
                value={comment}
              />
            </div>
            <DialogFooter>
              <Button
                className="h-8 rounded-lg px-3 text-xs"
                onClick={() => setShowDownvoteDialog(false)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                className="h-8 rounded-lg px-3 text-xs"
                disabled={isSubmitting || !onSubmitFeedback}
                size="sm"
                type="submit"
                variant="outline"
              >
                Send
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
