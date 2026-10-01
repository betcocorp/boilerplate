import Link from 'next/link';
import { ExternalLink } from 'lucide-react';

import {
  LEGACY_REF_PATTERN,
  legacyReferenceHref,
} from '~/lib/rag/document-source-links';

/**
 * Linkify `legacy:<table>:<pk>` references, pointing each at the legacy source record the
 * key belongs to. The embedded GUID is a legacy primary key (e.g. `prod_line.ProdLineKey`),
 * so it must NOT be treated as a `rag.document.id` — doing so resolves back to the
 * product_line_profile document that owns the key, i.e. this same page.
 */
export function LegacyReferenceText({ text }: { text: string }) {
  const parts: Array<{
    type: 'text' | 'link';
    value: string;
    table: string;
    pk: string;
  }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // A fresh instance per render: `LEGACY_REF_PATTERN` is a module-level /g regex, and advancing
  // its `lastIndex` would leak scan position into every other consumer of it.
  const pattern = new RegExp(LEGACY_REF_PATTERN.source, LEGACY_REF_PATTERN.flags);

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        type: 'text',
        value: text.slice(lastIndex, match.index),
        table: '',
        pk: '',
      });
    }

    parts.push({
      type: 'link',
      value: match[0],
      table: match[1],
      pk: match[2],
    });

    lastIndex = pattern.lastIndex;
  }

  if (parts.length === 0) {
    return <>{text}</>;
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex), table: '', pk: '' });
  }

  return (
    <>
      {parts.map((part, idx) => {
        if (part.type === 'text') {
          return part.value;
        }

        const href = legacyReferenceHref(part.table, part.pk);
        if (!href) {
          return part.value;
        }

        return (
          <Link
            key={idx}
            href={href}
            className="inline-flex items-center gap-1 font-mono text-sky-600 transition hover:text-sky-700 hover:underline"
            title={`Open legacy ${part.table} record ${part.pk}`}
          >
            {part.value}
            <ExternalLink className="size-3" />
          </Link>
        );
      })}
    </>
  );
}
