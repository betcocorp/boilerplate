import { ExternalLink } from 'lucide-react';

import type { SourceCorpus } from '~/lib/rag/source-file-signing';

type SourceFileLinkProps = {
  corpus: SourceCorpus;
  s3Key: string;
  className?: string;
};

/**
 * B0-684 — render an ingestion panel's S3 key as a link that opens the file itself.
 *
 * The href points at `/api/admin/rag/corpus-source-file`, which resolves the bucket from
 * `corpus` server-side and redirects to a short-lived signed URL. A plain anchor (not
 * `next/link`) because the destination is an off-app redirect that must not be prefetched
 * or handled by the router — prefetching would burn a signed URL before the user clicks.
 */
export function SourceFileLink({ corpus, s3Key, className }: SourceFileLinkProps) {
  const href = `/api/admin/rag/corpus-source-file?corpus=${encodeURIComponent(
    corpus,
  )}&key=${encodeURIComponent(s3Key)}`;

  return (
    <a
      className={`inline-flex items-baseline gap-1 font-mono text-xs text-sky-600 transition hover:text-sky-700 hover:underline ${className ?? ''}`}
      href={href}
      rel="noopener noreferrer"
      target="_blank"
      title="Open the source file (link expires shortly)"
    >
      <span className="break-all">{s3Key}</span>
      <ExternalLink aria-hidden className="size-3 shrink-0 self-center" />
    </a>
  );
}
