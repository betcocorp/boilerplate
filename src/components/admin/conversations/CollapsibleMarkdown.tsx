'use client';

/**
 * B0-533 — an assistant answer rendered as markdown, clamped to a few lines until expanded. The
 * only client state on the turn timeline is this toggle; everything else is server-rendered.
 */

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Button } from '~/components/ui/button';

const MARKDOWN_CLASS = [
  'text-sm leading-relaxed text-slate-700',
  '[&_h1]:mt-3 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-slate-900',
  '[&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-slate-900',
  '[&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-slate-900',
  '[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_li]:my-0.5 [&_strong]:font-semibold [&_strong]:text-slate-900',
  '[&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.8em]',
  '[&_table]:my-2 [&_table]:w-full [&_table]:text-xs [&_th]:border [&_th]:border-slate-200 [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-slate-200 [&_td]:px-2 [&_td]:py-1',
  '[&_a]:text-sky-700 [&_a]:underline-offset-2 hover:[&_a]:underline',
].join(' ');

/** Answers at or under this many characters never need the toggle. */
const COLLAPSE_THRESHOLD_CHARS = 600;

export function CollapsibleMarkdown({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = text.length > COLLAPSE_THRESHOLD_CHARS;

  return (
    <div className="min-w-0">
      <div
        className={`${MARKDOWN_CLASS} break-words ${collapsible && !expanded ? 'relative max-h-40 overflow-hidden' : ''}`}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        {collapsible && !expanded ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-white to-transparent"
          />
        ) : null}
      </div>
      {collapsible ? (
        <Button
          className="mt-1 h-7 px-2 text-xs"
          onClick={() => setExpanded((open) => !open)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {expanded ? 'Show less' : 'Show full answer'}
        </Button>
      ) : null}
    </div>
  );
}
