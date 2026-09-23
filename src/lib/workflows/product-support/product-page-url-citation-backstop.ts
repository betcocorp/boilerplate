import type { SourceRef } from '~/lib/conversations/conversation-schemas';

/**
 * B0-1075/B0-1076 attached a derived betco.com product-page `url` to internal `SourceRef`s and
 * rendered it in the admin Sources panel, but neither story told the MODEL that a cited source can
 * carry one — `product-support-prompts.ts`'s closing `Source:`/`Sources:` line instruction only
 * ever asks for the document name plus `[doc:uuid]`. Verified live (2026-09-23, "What is AF79?"):
 * the model's own citation line never mentioned the URL even though the source object had it.
 *
 * Same shape as `dilution-dwell-backstop.ts`: a deterministic, additive, text-level patch applied
 * to the FINISHED draft rather than a prompt re-wording, because prompt-only "mention this field"
 * instructions have repeatedly proven skippable (B0-788/B0-889/B0-976/B0-1002) and a wrong or
 * fabricated URL here would be worse than a missing one.
 *
 * Bex's chat body renders through `Streamdown` (real markdown, with its own link-safety
 * confirmation modal on every link) — so the fix emits standard `[text](url)` markdown, not raw
 * HTML, and lets Streamdown's existing link handling (styling, target, the safety modal) apply
 * uniformly to this link the same as any other.
 *
 * Deliberately confined to the model's closing `Source:`/`Sources:` LINE (per
 * `product-support-prompts.ts`'s "4. A closing Source: line" instruction) — never the whole draft.
 * A looser text-wide regex risks capturing arbitrary preceding prose as "link text" if a citation
 * marker ever appears without a semicolon/newline immediately before it; scoping to lines that
 * literally start with the label makes that impossible.
 *
 * Scoped to `product_line_profile` sources ONLY. `url` is currently attached to every SourceRef
 * that shares a web-visible product line regardless of `documentKind` (B0-1075 did not gate by
 * kind), but the betco.com product page is only the semantically correct link target for the
 * product-profile citation itself — a `label`/`sds` source should link to ITS OWN origin document
 * (the S3 PDF/image), not the generic catalog page, and there is no S3-origin link infrastructure
 * in this codebase yet (`sourceUri` is a raw `s3://bucket/key` string; nothing generates a public
 * or presigned browser URL from it). Rather than mislabel a label/SDS citation with the wrong link,
 * this backstop only converts `product_line_profile` citations for now; B0-1085/B0-1086/B0-1087
 * (filed 2026-09-23) track building real origin links for the other kinds. This module never
 * invents a URL — it only ever attaches one already present on the matching `SourceRef`.
 */

/** A line consisting only of the model's closing citation label, e.g. "Sources: A [doc:x]; B [doc:y]." */
const CITATION_LINE_PATTERN = /^(\s*sources?:\s*)(.*)$/i;

/**
 * One semicolon-delimited citation segment within a citation line: `<name in words> [doc:<id>]`,
 * with an optional trailing period on the last segment. Captures leading whitespace (group 1, so
 * the "; " separator's space survives the rewrite), the name (group 2, trimmed), and the id
 * (group 3).
 */
const CITATION_SEGMENT_PATTERN = /(\s*)([^;]*?)\s*\[doc:([^\]]+)\]/g;

/** Document kinds this backstop currently knows how to link. See the module comment for why the rest are excluded. */
const LINKABLE_DOCUMENT_KINDS = new Set<SourceRef['documentKind']>(['product_line_profile']);

export type ProductPageUrlCitationBackstopResult = {
  answer: string;
  applied: boolean;
};

/**
 * Rewrites each `<name> [doc:<documentId>]` segment on the draft's closing `Source:`/`Sources:`
 * line as a markdown link `[<name>](<url>)` when the matching source is a `product_line_profile`
 * carrying a `url`. Every other line, and every segment without a qualifying source, is left
 * exactly as the model wrote it. Attaches at most once per distinct `documentId`.
 */
export function applyProductPageUrlCitationBackstop(input: {
  draftAnswer: string;
  sources: SourceRef[];
}): ProductPageUrlCitationBackstopResult {
  const linkableByDocumentId = new Map<string, string>();
  for (const source of input.sources) {
    if (
      source.url &&
      source.documentId &&
      LINKABLE_DOCUMENT_KINDS.has(source.documentKind) &&
      !linkableByDocumentId.has(source.documentId)
    ) {
      linkableByDocumentId.set(source.documentId, source.url);
    }
  }
  if (linkableByDocumentId.size === 0) {
    return { answer: input.draftAnswer, applied: false };
  }

  let applied = false;
  const linked = new Set<string>();
  const lines = input.draftAnswer.split('\n').map((line) => {
    const citationLineMatch = line.match(CITATION_LINE_PATTERN);
    if (!citationLineMatch) {
      return line;
    }
    const [, label, rest] = citationLineMatch;
    const rewrittenRest = rest.replace(
      CITATION_SEGMENT_PATTERN,
      (segment, leadingWhitespace: string, name: string, id: string) => {
        const url = linkableByDocumentId.get(id);
        const trimmedName = name.trim();
        if (!url || linked.has(id) || !trimmedName) {
          return segment;
        }
        linked.add(id);
        applied = true;
        return `${leadingWhitespace}[${trimmedName}](${url})`;
      },
    );
    return `${label}${rewrittenRest}`;
  });

  return { answer: applied ? lines.join('\n') : input.draftAnswer, applied };
}
