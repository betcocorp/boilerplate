'use client';

import { ChevronUp } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';

const SCROLL_TOP_THRESHOLD_PX = 8;

type AdminScrollableMainProps = {
  children: ReactNode;
  className?: string;
};

/**
 * Wraps admin main content in the scroll container and shows a fixed scroll-to-top control
 * when the user has scrolled down (admin layout scrolls this div, not the window).
 */
export function AdminScrollableMain({ children, className }: AdminScrollableMainProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }

    const update = () => {
      setShowScrollTop(el.scrollTop > SCROLL_TOP_THRESHOLD_PX);
    };

    update();
    el.addEventListener('scroll', update, { passive: true });
    return () => el.removeEventListener('scroll', update);
  }, []);

  function scrollToTop() {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <>
      <div
        ref={scrollRef}
        className={cn('min-h-0 flex-1 overflow-y-auto', className)}
      >
        {children}
      </div>

      <Button
        aria-label="Scroll to top"
        className={cn(
          'fixed bottom-6 right-6 z-30 size-11 rounded-full shadow-md transition-opacity duration-200',
          showScrollTop ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={scrollToTop}
        size="icon"
        tabIndex={showScrollTop ? 0 : -1}
        type="button"
        variant="secondary"
      >
        <ChevronUp className="size-5" />
      </Button>
    </>
  );
}
