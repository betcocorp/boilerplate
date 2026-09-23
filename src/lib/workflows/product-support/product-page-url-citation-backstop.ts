import type { SourceRef } from '~/lib/conversations/conversation-schemas';

/**
 * B0-1075/B0-1076 attached a derived betco.com product-page `url` to internal `SourceRef`s and
 * rendered it in the admin Sources panel, but neither story told the MODEL that a cited source can
 * carry one — `product-support-prompts.ts`'s closing `Source:`/`Sources:` line instruction only
 * ever asks for the document name plus `[doc:uuid]`. Verified live (2026-09-23, "What is AF79?"):
 * the model's own citation line never mentions the URL even though the source object had it. B0-1075
 * anticipated exactly this ("add to the prompt guidance only if the model does not surface it
 * naturally — flag rather than assume") but nobody checked before landing.
 *
 * Same shape as `dilution-dwell-backstop.ts`: a deterministic, additive, text-level patch applied
 * to the FINISHED draft rather than a prompt re-wording, because prompt-only "mention this field"
 * instructions have repeatedly proven skippable (B0-788/B0-889/B0-976/B0-1002) and a wrong or
 * fabricated URL here would be worse than a missing one. This module never invents a URL — it only
 * ever attaches one already present on the matching `SourceRef` (set by `fetchProductLineWebUrls`,
 * which is itself gated on `OnWeb` and the B0-1077 live link check).
 */

/** Matches every `[doc:<id>]` marker, including the synthetic `verified-facts`/`verified-facts:<key>` forms. */
const DOC_CITATION_MARKER_PATTERN = /\[doc:([^\]]+)\]/g;

export type ProductPageUrlCitationBackstopResult = {
  answer: string;
  applied: boolean;
};

/**
 * Appends "(<url>)" immediately after each `[doc:<documentId>]` marker in `draftAnswer` whose
 * matching source carries a `url`. Attaches at most once per distinct `documentId` (its first
 * citation), so a document cited more than once does not get the link repeated. A no-op whenever
 * no source has a `url`, or none of those sources are actually cited in the text.
 */
export function applyProductPageUrlCitationBackstop(input: {
  draftAnswer: string;
  sources: SourceRef[];
}): ProductPageUrlCitationBackstopResult {
  const urlByDocumentId = new Map<string, string>();
  for (const source of input.sources) {
    if (source.url && source.documentId && !urlByDocumentId.has(source.documentId)) {
      urlByDocumentId.set(source.documentId, source.url);
    }
  }
  if (urlByDocumentId.size === 0) {
    return { answer: input.draftAnswer, applied: false };
  }

  let applied = false;
  const attached = new Set<string>();
  const answer = input.draftAnswer.replace(DOC_CITATION_MARKER_PATTERN, (marker, id: string) => {
    const url = urlByDocumentId.get(id);
    if (!url || attached.has(id)) {
      return marker;
    }
    attached.add(id);
    applied = true;
    return `${marker} (${url})`;
  });

  return { answer, applied };
}
