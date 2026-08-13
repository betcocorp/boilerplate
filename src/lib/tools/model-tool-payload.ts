/**
 * B0-437 — the model-facing half of a tool payload.
 *
 * Until now ONE serialized JSON string was both what the model saw and what every downstream
 * consumer parsed: `executeToolCall` returns `{ output }`, the workflow logs that string into
 * `toolOutputLog`, and the runtime hands the same string back to the model. So shrinking the model's
 * copy also shrank the validator's and the regulated-claim guardrail's copy — which the regulated-data
 * rule forbids.
 *
 * This module derives a slimmer variant for the model ONLY. The full payload is unchanged and is what
 * `toolOutputLog` keeps, so `buildEvidenceSummary`, `evaluateRegulatedClaimGrounding`,
 * `evaluateUsageSafetyCoverage`, `collectSourcesFromToolOutputs` (which persists `snippet` for the UI)
 * and `collectSourceMetaFromToolOutputs` all still read the full 30k-per-document assembly.
 *
 * It derives rather than being built inside `sourcePayload` because the model shape is a strict
 * projection of the full shape: every field it emits already exists on the full source, so there is
 * exactly one place the two can disagree (the body length metadata below), and it is handled here.
 *
 * Measured waste this removes, per `search_product_docs` call at 3 sources:
 * - `snippet` (`trimSnippet(chunk_text, 900)`) and `matchedChunkText` are both already contained in
 *   `documentBody`, which is assembled from every chunk of the parent document — so the matched chunk
 *   reached the model up to three times (~1,370 tokens/search at ~924 avg chars/chunk).
 * - assembled bodies average 11,227 chars for `sds` (p95 22,866) against a 30k assembly cap; a
 *   profile+SDS+label triple is ~18,400 chars before the duplication above.
 */

/**
 * Per-source cap on the body the MODEL sees. Deliberately separate from
 * `DEFAULT_MAX_CHARS_PER_DOCUMENT` (30k) in `~/lib/retrieval/document-assembly`, which the validator
 * and the guardrail depend on and which must NOT change.
 *
 * 8k is consistent with `USAGE_SAFETY_COVERAGE_BODY_SCAN_MAX_CHARS` (4k), which already assumes Betco
 * labels/SDS put directions and hazard/first-aid statements early — and the truncation below is
 * section-aware, so a regulated section that sits late in a long SDS is kept rather than dropped.
 */
export const MODEL_DOCUMENT_BODY_MAX_CHARS = 8_000;

/** Marker left where sections were dropped, so the model can see the copy is partial. */
export const MODEL_BODY_OMISSION_MARKER = '…(omitted)';

/**
 * Headings whose content a regulated claim may have to be transcribed from verbatim (EPA reg number,
 * dilution ratio, contact time, hazard statement, first-aid instruction). These are retained ahead of
 * ordinary prose when the 8k budget forces a choice.
 */
const REGULATED_SECTION_HEADING_PATTERN =
  /(first[\s-]?aid|hazard|precaution|direction|dilut|use\s+solution|contact\s*time|dwell|regulatory|epa|registration|ppe|personal protective|exposure|handling|storage|disposal|active ingredient|efficacy|kill)/i;

type BodySection = {
  heading: string | null;
  /** The section exactly as it appears in the assembled body, heading line included. */
  raw: string;
};

/**
 * Splits an assembled document body back into its sections. `assembleDocumentBodies` joins chunk
 * segments with a blank line and prefixes a chunk's heading with `## `, so a blank line immediately
 * followed by `## ` is a section boundary. Bodies with no headings come back as a single section and
 * fall through to plain head-truncation.
 */
function splitAssembledBody(body: string): BodySection[] {
  return body.split(/\n\n(?=## )/).map((raw) => {
    const headingMatch = /^## (.*)$/m.exec(raw.split('\n')[0] ?? '');
    return { heading: headingMatch?.[1]?.trim() ?? null, raw };
  });
}

export type ModelDocumentBody = {
  body: string;
  /** True when `body` is not the complete assembled document — accurate for THIS body, not the full one. */
  truncated: boolean;
};

/**
 * Caps a document body for the model, keeping whole sections and preferring the ones a regulated
 * claim would have to be quoted from. Output stays in original document order.
 */
export function truncateDocumentBodyForModel(
  body: string,
  maxChars: number = MODEL_DOCUMENT_BODY_MAX_CHARS,
): ModelDocumentBody {
  if (body.length <= maxChars) {
    return { body, truncated: false };
  }

  const sections = splitAssembledBody(body);
  const headTruncate = (): ModelDocumentBody => ({
    body: `${body.slice(0, Math.max(0, maxChars - MODEL_BODY_OMISSION_MARKER.length))}${MODEL_BODY_OMISSION_MARKER}`,
    truncated: true,
  });

  if (sections.length <= 1) {
    return headTruncate();
  }

  const separator = '\n\n';
  const keep = new Array<boolean>(sections.length).fill(false);
  let used = 0;

  const tryKeep = (index: number) => {
    const section = sections[index];
    if (!section || keep[index]) {
      return;
    }
    const cost = section.raw.length + (used > 0 ? separator.length : 0);
    if (used + cost > maxChars) {
      return;
    }
    keep[index] = true;
    used += cost;
  };

  // Pass 1 — regulated sections first, in document order, so a late SDS "Regulatory information" or
  // "First-aid measures" section survives a cap that plain head-truncation would have cut.
  for (let index = 0; index < sections.length; index += 1) {
    if (REGULATED_SECTION_HEADING_PATTERN.test(sections[index]?.heading ?? '')) {
      tryKeep(index);
    }
  }
  // Pass 2 — fill what is left with the earliest remaining sections (product identity and directions
  // are front-loaded in Betco labels and SDS).
  for (let index = 0; index < sections.length; index += 1) {
    tryKeep(index);
  }

  if (!keep.some(Boolean)) {
    return headTruncate();
  }

  const pieces: string[] = [];
  let omitting = false;
  for (let index = 0; index < sections.length; index += 1) {
    if (keep[index]) {
      pieces.push(sections[index]!.raw);
      omitting = false;
      continue;
    }
    if (!omitting) {
      pieces.push(MODEL_BODY_OMISSION_MARKER);
      omitting = true;
    }
  }

  return { body: pieces.join(separator), truncated: true };
}

type FullSource = Record<string, unknown>;

function readString(source: FullSource, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Projects one full source onto the model shape.
 *
 * Body metadata honesty (B0-13 auditability): each payload's `documentBody*` fields describe the body
 * IT carries. The full payload keeps describing the full assembly. Here:
 * - `documentBodyChars` is the length of the model's body.
 * - `documentBodyTruncated` is true whenever the model's body is not the whole document (either this
 *   cap or the upstream 30k assembly cap).
 * - `documentBodyFullChars` says how much document exists behind it.
 * - `documentBodyChunkCount` / `documentBodyChunkIds` / `documentBodyTokenEstimate` describe the chunk
 *   composition of the assembled body, which cannot be restated accurately once sections are dropped
 *   at character granularity — so they are carried ONLY when the model's body is byte-identical to it,
 *   and omitted otherwise rather than copied over as if still true.
 */
function buildModelSource(source: FullSource): Record<string, unknown> {
  const fullBody = readString(source, 'documentBody');
  const { body, truncated } = truncateDocumentBodyForModel(fullBody);
  const cappedForModel = body !== fullBody;

  return {
    documentId: source.documentId,
    chunkId: source.chunkId,
    title: source.title,
    documentBody: body,
    documentBodyChars: body.length,
    documentBodyTruncated: truncated || source.documentBodyTruncated === true,
    ...(cappedForModel ? { documentBodyFullChars: fullBody.length } : {}),
    ...(cappedForModel
      ? {}
      : {
          documentBodyChunkCount: source.documentBodyChunkCount,
          documentBodyChunkIds: source.documentBodyChunkIds,
          documentBodyTokenEstimate: source.documentBodyTokenEstimate,
        }),
    confidence: source.confidence,
    documentKind: source.documentKind,
    productLineKey: source.productLineKey,
    productKey: source.productKey,
    // B0-257 — citation provenance; the model needs these to cite the exact label/SDS.
    s3Key: source.s3Key,
    sourceUri: source.sourceUri,
  };
}

/**
 * Returns the model-facing variant of a tool payload, or null when there is nothing to slim (no
 * `sources` array — e.g. `get_escalation_policy`, `lookup_cross_reference`, the category tools).
 *
 * `snippet` and `matchedChunkText` are dropped: both are substrings of `documentBody`, which the
 * prompt already tells the model to read for grounding.
 */
export function buildModelToolPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const sources = payload.sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    return null;
  }

  return {
    ...payload,
    sources: sources.map((source) =>
      source && typeof source === 'object' && !Array.isArray(source)
        ? buildModelSource(source as FullSource)
        : source,
    ),
  };
}
