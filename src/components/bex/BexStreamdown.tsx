'use client';

import { defaultTranslations, Streamdown } from 'streamdown';
import type { LinkSafetyModalProps } from 'streamdown';

import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { cn } from '~/lib/utils';

const t = defaultTranslations;

function BexExternalLinkSafetyModal({
  isOpen,
  onClose,
  onConfirm,
  url,
}: LinkSafetyModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-[min(28rem,calc(100vw-2rem))] gap-4 sm:max-w-md"
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle>{t.openExternalLink}</DialogTitle>
          <DialogDescription>{t.externalLinkWarning}</DialogDescription>
        </DialogHeader>
        <p className="max-h-32 overflow-y-auto break-all rounded-xl border border-border/60 bg-muted/40 px-3 py-2 font-mono text-[0.75rem] leading-snug text-muted-foreground">
          {url}
        </p>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={onClose}>
            {t.close}
          </Button>
          <Button type="button" onClick={onConfirm}>
            {t.openLink}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
        /* Preflight strips list padding/markers; list-inside keeps bullets inside the bubble (overflow-hidden won’t clip). */
        '[&_ul]:my-2 [&_ul]:list-inside [&_ul]:list-disc [&_ul]:ps-4 [&_ul]:pe-1',
        '[&_ol]:my-2 [&_ol]:list-inside [&_ol]:list-decimal [&_ol]:ps-4 [&_ol]:pe-1',
        '[&_li]:my-1 [&_li]:leading-relaxed',
        '[&_ul_ul]:mt-1.5 [&_ul_ul]:ps-4 [&_ol_ol]:mt-1.5 [&_ol_ol]:ps-4',
        isUser
          ? '[&_code]:bg-primary-foreground/15 [&_pre]:bg-primary-foreground/10'
          : '[&_code]:bg-muted [&_pre]:bg-muted',
        className,
      )}
    >
      <Streamdown
        isAnimating={isStreaming}
        linkSafety={{
          enabled: true,
          renderModal: BexExternalLinkSafetyModal,
        }}
      >
        {content}
      </Streamdown>
      {isStreaming && content.trim() ? (
        <span
          aria-hidden
          className="ml-1 inline-block h-4 w-[2px] animate-pulse rounded bg-current/35 align-[-0.2em]"
        />
      ) : null}
    </div>
  );
}
