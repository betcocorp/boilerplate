'use client';

import { Streamdown } from 'streamdown';

import { cn } from '~/lib/utils';

type BexStreamdownProps = {
  content: string;
  isStreaming: boolean;
  isUser: boolean;
  className?: string;
};

export function BexStreamdown({
  content,
  isStreaming,
  isUser,
  className,
}: BexStreamdownProps) {
  return (
    <div
      className={cn(
        'mt-2 wrap-break-word [&_a]:underline [&_a]:underline-offset-2 [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_pre]:mt-2 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:p-3 [&_pre]:text-xs',
        isUser
          ? '[&_code]:bg-primary-foreground/15 [&_pre]:bg-primary-foreground/10'
          : '[&_code]:bg-muted [&_pre]:bg-muted',
        className,
      )}
    >
      <Streamdown isAnimating={isStreaming}>{content}</Streamdown>
      {isStreaming && content.trim() ? (
        <span
          aria-hidden
          className="ml-1 inline-block h-4 w-[2px] animate-pulse rounded bg-current/35 align-[-0.2em]"
        />
      ) : null}
    </div>
  );
}
