import { z } from 'zod';

/**
 * B0-293 — the corpus a retrieved source came from.
 *
 * The first five values are the LIVE distinct values of `rag.document.document_kind` (verified
 * against the database, not inferred): `sds`, `product_line_profile`, `label`, `efficacy`,
 * `knowledge`. `facts` is the one synthetic kind the tool layer emits — `product-tools.ts` unshifts
 * a "Verified Product Facts (structured)" source built from structured product facts, which has no
 * `rag.document` row behind it (its `documentId` is `VERIFIED_FACTS_SOURCE_ID`, not a uuid).
 *
 * Deliberately NOT a taxonomy of our own invention, and deliberately not extended with `web`: an
 * external source is already flagged by `SourceRef.kind === 'external'` and renders as a link, so a
 * second spelling for the same fact would let the two disagree.
 */
export const RAG_DOCUMENT_KINDS = [
  'sds',
  'label',
  'product_line_profile',
  'efficacy',
  'knowledge',
  'facts',
] as const;

export const ragDocumentKindSchema = z.enum(RAG_DOCUMENT_KINDS);

export type RagDocumentKind = (typeof RAG_DOCUMENT_KINDS)[number];

const DOCUMENT_KIND_LABELS: Record<RagDocumentKind, string> = {
  sds: 'SDS',
  label: 'Label',
  product_line_profile: 'Product',
  efficacy: 'Efficacy',
  knowledge: 'Knowledge',
  facts: 'Verified facts',
};

/** Short badge text for a source's corpus. Unknown/absent kinds get no label (never a guess). */
export function documentKindLabel(kind: string | null | undefined): string | null {
  if (!kind) {
    return null;
  }
  const parsed = ragDocumentKindSchema.safeParse(kind);
  return parsed.success ? DOCUMENT_KIND_LABELS[parsed.data] : null;
}

/** Narrow an arbitrary tool-payload string to a known kind, or null. */
export function asRagDocumentKind(value: unknown): RagDocumentKind | null {
  const parsed = ragDocumentKindSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
