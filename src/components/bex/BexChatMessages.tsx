'use client';

import {
  Bot,
  ChevronDown,
  ChevronRight,
  Copy,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  User,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';

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
import { cn } from '~/lib/utils';

import { BEX_SUGGESTIONS } from '~/lib/bex/constants';
import type { ChatMessage } from '~/types/bex';

type BexChatMessagesProps = {
  messages: ChatMessage[];
  isTyping: boolean;
  showWelcome: boolean;
  onSuggestion: (text: string) => void;
  onStartEmptyChat?: () => void;
  feedbackSubmittingMessageId?: string | null;
  onSubmitFeedback?: (input: {
    messageId: string;
    rating: 'up' | 'down';
    reasonCode?: string;
    comment?: string;
  }) => Promise<void>;
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

function markdownComponentsForBubble(isUser: boolean): Components {
  const inlineCode = cn(
    'rounded px-1 py-0.5 text-[0.85em] font-mono',
    isUser ? 'bg-primary-foreground/15' : 'bg-muted',
  );
  const blockPre = cn(
    'mt-2 overflow-x-auto rounded-xl p-3 text-xs leading-relaxed first:mt-0',
    isUser ? 'bg-primary-foreground/10' : 'bg-muted',
  );
  const blockCodeText = isUser ? 'text-primary-foreground' : 'text-foreground';

  return {
    p: ({ children }) => (
      <p className="mt-2 wrap-break-word first:mt-0">{children}</p>
    ),
    strong: ({ children }) => (
      <strong className="font-semibold">{children}</strong>
    ),
    em: ({ children }) => <em className="italic">{children}</em>,
    ul: ({ children }) => (
      <ul className="mt-2 list-disc space-y-1 pl-5 first:mt-0">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="mt-2 list-decimal space-y-1 pl-5 first:mt-0">
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="wrap-break-word">{children}</li>,
    a: ({ href, children }) => (
      <a
        className="wrap-break-word underline underline-offset-2"
        href={href}
        rel="noopener noreferrer"
        target="_blank"
      >
        {children}
      </a>
    ),
    code: ({ className, children, ...props }) => {
      const isBlock = Boolean(className?.includes('language-'));
      if (isBlock) {
        return (
          <code
            className={cn('font-mono text-xs', blockCodeText, className)}
            {...props}
          >
            {children}
          </code>
        );
      }
      return (
        <code className={inlineCode} {...props}>
          {children}
        </code>
      );
    },
    pre: ({ children }) => <pre className={blockPre}>{children}</pre>,
    blockquote: ({ children }) => (
      <blockquote
        className={cn(
          'mt-2 border-l-2 pl-3 italic first:mt-0',
          isUser ? 'border-primary-foreground/40' : 'border-border',
        )}
      >
        {children}
      </blockquote>
    ),
    h1: ({ children }) => (
      <h1 className="mt-3 text-base font-semibold first:mt-0">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="mt-2 text-sm font-semibold first:mt-0">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="mt-2 text-sm font-medium first:mt-0">{children}</h3>
    ),
    hr: () => (
      <hr
        className={cn(
          'my-3 border-0 border-t',
          isUser ? 'border-primary-foreground/25' : 'border-border/60',
        )}
      />
    ),
  };
}

function AssistantDetails({
  messageId,
  meta,
}: {
  messageId: string;
  meta: NonNullable<ChatMessage['meta']>;
}) {
  const [open, setOpen] = useState(false);

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
      </Button>
      {open ? (
        <div className="mt-2 space-y-2 rounded-xl bg-muted/50 p-3 text-left">
          {meta.confidence !== undefined ? (
            <p>
              <span className="font-medium text-foreground">Confidence:</span>{' '}
              {meta.confidence.toFixed(2)}
            </p>
          ) : null}
          {meta.validation ? (
            <p>
              <span className="font-medium text-foreground">Validation:</span>{' '}
              {meta.validation.approved ? 'approved' : 'not approved'}
              {meta.validation.requiresHumanReview ? ' · human review' : ''}
            </p>
          ) : null}
          {meta.validation?.issues && meta.validation.issues.length > 0 ? (
            <div>
              <span className="font-medium text-foreground">Issues</span>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {meta.validation.issues.map((issue) => (
                  <li key={`${messageId}-${issue}`}>{issue}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {meta.sources && meta.sources.length > 0 ? (
            <div>
              <span className="font-medium text-foreground">Sources</span>
              <ul className="mt-1 space-y-1">
                {meta.sources.slice(0, 8).map((s) => (
                  <li
                    className="wrap-break-word"
                    key={`${messageId}-${s.documentId}`}
                  >
                    <span className="font-mono text-[0.7rem] opacity-80">
                      {s.documentId.slice(0, 8)}…
                    </span>{' '}
                    {s.title}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {meta.toolSummary && meta.toolSummary.length > 0 ? (
            <div>
              <span className="font-medium text-foreground">Tool calls</span>
              <ul className="mt-1 space-y-1">
                {meta.toolSummary.map((tool, index) => (
                  <li
                    className="wrap-break-word"
                    key={`${messageId}-${tool.name}-${index}`}
                  >
                    <span className="font-mono text-[0.7rem] opacity-80">
                      {tool.ok ? 'ok' : 'failed'}
                    </span>{' '}
                    {tool.name}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {meta.workflowRunId ? (
            <p className="font-mono text-[0.65rem] opacity-70">
              Run: {meta.workflowRunId}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function BexChatMessageBody({
  content,
  isUser,
}: {
  content: string;
  isUser: boolean;
}) {
  const components = useMemo(
    () => markdownComponentsForBubble(isUser),
    [isUser],
  );

  return (
    <div className="mt-2">
      <ReactMarkdown components={components}>{content}</ReactMarkdown>
    </div>
  );
}

export function BexChatMessages({
  isTyping,
  messages,
  feedbackSubmittingMessageId,
  onSubmitFeedback,
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
                  <BexChatMessageBody content={m.content} isUser={isUser} />
                  {!isUser ? (
                    <div className="mt-3">
                      <AssistantFeedbackActions
                        feedback={m.feedback}
                        isSubmitting={feedbackSubmittingMessageId === m.id}
                        messageId={m.id}
                        onSubmitFeedback={onSubmitFeedback}
                      />
                    </div>
                  ) : null}
                  {!isUser && m.meta ? (
                    <AssistantDetails messageId={m.id} meta={m.meta} />
                  ) : null}
                  {!isUser && (
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
            feedback?.rating === 'up' && 'bg-muted text-foreground',
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
            feedback?.rating === 'down' && 'bg-muted text-foreground',
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
