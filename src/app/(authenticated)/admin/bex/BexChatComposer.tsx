'use client';

import { Paperclip, SendHorizontal } from 'lucide-react';
import { useCallback, useRef } from 'react';

import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';

type BexChatComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder?: string;
};

export function BexChatComposer({
  disabled,
  onChange,
  onSend,
  placeholder = 'Message Bex…',
  value,
}: BexChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend();
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    });
  }, [disabled, onSend, value]);

  return (
    <div className="border-t border-border/60 bg-background/95 p-3 backdrop-blur sm:p-4">
      <div className="mx-auto w-full">
        <div
          className={cn(
            'flex flex-col gap-2 rounded-3xl border border-border/60 bg-muted/30 p-2 shadow-sm transition-colors',
            'focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20',
          )}
        >
          <textarea
            aria-label="Message input"
            className="max-h-[200px] min-h-[44px] w-full resize-none bg-transparent px-3 py-2 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
            disabled={disabled}
            onChange={(e) => {
              onChange(e.target.value);
              resize();
            }}
            onInput={resize}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={placeholder}
            ref={textareaRef}
            rows={1}
            value={value}
          />
          <div className="flex items-center justify-between gap-2 px-1 pb-1">
            <Button
              aria-label="Attach file (coming soon)"
              className="rounded-2xl text-muted-foreground"
              disabled
              size="sm"
              title="Attachments coming soon"
              type="button"
              variant="ghost"
            >
              <Paperclip className="size-4" />
              <span className="hidden sm:inline">Attach</span>
            </Button>
            <div className="flex items-center gap-2">
              <span className="hidden text-xs text-muted-foreground sm:inline">
                Enter to send · Shift+Enter for newline
              </span>
              <Button
                className="rounded-2xl"
                disabled={disabled || !value.trim()}
                onClick={handleSend}
                type="button"
              >
                <SendHorizontal className="size-4" />
                Send
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
