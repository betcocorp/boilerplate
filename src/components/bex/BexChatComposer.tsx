'use client';

import { Paperclip, SendHorizontal } from 'lucide-react';
import { useCallback, useRef } from 'react';

import { Button } from '~/components/ui/button';
import { Label } from '~/components/ui/label';
import { Switch } from '~/components/ui/switch';
import { Textarea } from '~/components/ui/textarea';
import { cn } from '~/lib/utils';

type BexChatComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  useValidator: boolean;
  onUseValidatorChange: (value: boolean) => void;
  disabled?: boolean;
  placeholder?: string;
};

export function BexChatComposer({
  disabled,
  onChange,
  onSend,
  onUseValidatorChange,
  placeholder = 'Message Bex…',
  useValidator,
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
          <Textarea
            aria-label="Message input"
            className="max-h-[200px] min-h-[44px] w-full resize-none border-0 bg-transparent px-3 py-2 text-sm leading-relaxed text-foreground shadow-none ring-0 focus-visible:ring-0 disabled:opacity-50"
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
              <Label
                className="mr-1 inline-flex items-center gap-2 text-xs text-muted-foreground"
                htmlFor="bex-use-validator"
              >
                <Switch
                  checked={useValidator}
                  disabled={disabled}
                  id="bex-use-validator"
                  onCheckedChange={onUseValidatorChange}
                  size="sm"
                />
                Use validator
              </Label>
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
