import type { ResolvedContext } from '~/lib/tests/retrieval-dataset';

/**
 * Quoted-span verbatim match (Phase 1 of `src/docs/rag-evaluation-process.md`).
 *
 * Of the spans an answer presents as quoted, what share actually appear verbatim in what was
 * retrieved for that turn. Deterministic, no model call, so it runs on every item of every run.
 * It is a strict subset of faithfulness — a fabricated quotation is always an ungrounded claim,
 * but an ungrounded claim need not be quoted — which makes it a cheap pre-filter rather than a
 * replacement for Phase 2.
 *
 * ## Everything below was measured, not assumed
 *
 * Against 5,305 persisted answers in the local corpus (2026-06-25 → 2026-09-11):
 *
 * - 1,543 answers (29%) contain straight double quotes; 191 contain curly quotes. Markdown
 *   blockquotes: **zero**. Backticks: 4. So quote characters are the only citation convention
 *   worth parsing, and the two glyph families both have to be handled.
 * - 3,443 quoted spans total, 1,976 of them 5 words or longer.
 * - Of a 494-span sample, only **106 (21%) appear in `chunk_text`** — but **325 (66%) appear in a
 *   document title or chunk heading**, and 417 (84%) in one or the other.
 *
 * That last number is the whole design. Bex overwhelmingly quotes *what a source is called*
 * ("Daily Care & Cleaning for Wood Gym Floors", "01 VCT Stripping Failures and Best Practices")
 * rather than what a source says. A haystack of chunk bodies alone would report a ~79% fabrication
 * rate that is almost entirely false alarms. Titles and headings are therefore part of the
 * haystack, and title citations are counted separately from content quotations because they are
 * different claims: one asserts provenance, the other asserts a fact.
 */

/** What a matched span was found in. Null when nothing matched. */
export type QuotedSpanMatchSource = 'chunk_text' | 'document_title' | 'heading';

/**
 * How a span is being treated.
 *
 * - `content` — matched inside a retrieved chunk body. The model quoted what a document says.
 * - `title` — matched a document title or chunk heading. The model cited what a document is
 *   called. Legitimate and checkable, but it is not evidence for any factual claim.
 * - `unmatched` — found nowhere in the retrieved material.
 */
export type QuotedSpanKind = 'content' | 'title' | 'unmatched';

export type QuotedSpanVerdict = {
  /** The span exactly as it appeared in the answer, before normalization. */
  span: string;
  wordCount: number;
  kind: QuotedSpanKind;
  matchedIn: QuotedSpanMatchSource | null;
  /** Provenance of the match, so a verdict is debuggable without re-running the join. */
  matchedDocumentId: string | null;
  matchedChunkId: string | null;
  /**
   * The span looks like a quote-pairing artifact rather than a real quotation. Counted and
   * reported, never scored: see {@link scoreQuotedSpans}.
   */
  pairingDriftSuspected: boolean;
};

export type QuotedSpanResult = {
  /**
   * Matched ÷ scorable. **Null, never 0, when there is nothing to score** — an answer that quotes
   * nothing has not failed at quoting, and averaging a 0 into a run would punish the plainest
   * answers hardest.
   */
  score: number | null;
  /**
   * The same ratio over content quotations only, with title citations excluded from BOTH sides.
   * This is the number that speaks to grounding; `score` speaks to citation hygiene. Null when no
   * span was a content quotation attempt.
   */
  contentScore: number | null;
  /** Spans that were scored (drift-suspected spans excluded). */
  scorable: number;
  matched: number;
  contentMatches: number;
  titleCitations: number;
  /** Extracted but excluded from scoring as probable pairing artifacts. */
  driftExcluded: number;
  spans: QuotedSpanVerdict[];
  /** Chunks whose text was actually available to match against. */
  resolvedChunks: number;
  /**
   * Refs whose text could not be joined. A span "not found" while these are non-zero may simply be
   * in text we could not read, so a low score here is not evidence of fabrication.
   */
  unresolvedRefs: number;
};

export type QuotedSpanOptions = {
  /**
   * Minimum words for a span to be considered a quotation. Default 5.
   *
   * Measured: at a 3-word floor the extraction admits inch-mark debris (`x 12`, `/4 oz., 4`) from
   * dimension text like `9" x 9"`; at 5 the sample was clean. Short spans are also the ones most
   * likely to match a chunk by coincidence, which would inflate the score rather than deflate it.
   */
  minWords?: number;
};

const DEFAULT_MIN_WORDS = 5;

/**
 * Curly quotes → straight, so `“zero installation”` and `"zero installation"` compare equal.
 * Applied to both the answer and the haystack.
 */
const CURLY_DOUBLE = /[“”„‟″‶]/g;
const CURLY_SINGLE = /[‘’‚‛′‵]/g;
/** En/em dash and friends → ASCII hyphen: sources write `2-3 hours`, answers often write `2–3`. */
const UNICODE_DASH = /[‐-―−]/g;
/**
 * `&` → `and`. Measured: the model renders document titles with an ampersand where the corpus
 * stores the word — `Wood Gym Floor Restoration & Repair FAQ Guide` against a stored
 * `…Restoration and Repair FAQ Guide` (4 occurrences in a 400-item sample). The citation is
 * genuine and verifiable; only the glyph differs, so reporting it as fabricated would be a grader
 * bug, not a finding. Safe for regulated data — an ampersand carries no meaning in a dilution
 * ratio, registration number or ppm value.
 */
const AMPERSAND = /\s*&\s*/g;

/**
 * An inch mark, not a quote character: a double quote immediately following a digit, as in
 * `9" x 9"` tile sizes.
 *
 * These must be removed BEFORE pairing, because an unpaired quote does not merely produce one bad
 * span — it inverts the open/close parity for the rest of the answer, so every subsequent
 * quotation is extracted with its boundaries shifted by one. Measured in the corpus as spans like
 * `x 9` (16 occurrences), `x 12`, `x 18`.
 */
const INCH_MARK = /(\d\s*)"/g;

/**
 * Normalizes for comparison only — never for display.
 *
 * Deliberately conservative about what it touches. Whitespace, letter case and glyph variants of
 * quotes and dashes are noise. Everything else is left exactly as written, because this corpus's
 * meaning lives in punctuation and digits: `1:64` must not become `164`, `EPA Reg. No. 6836-78`
 * must keep its periods and hyphen, `200 ppm` and `10 minutes` must keep the space between value
 * and unit. Stripping punctuation would make `1:64` and `1:6` collide, which is the exact class of
 * error this metric exists to catch.
 *
 * `®` and `™` are also left in place. They could be stripped to catch `StreetShoe® NXT` against a
 * source reading `StreetShoe NXT`, but the corpus carries the marks in its own titles, so removing
 * them buys little and widens what counts as a match.
 */
export function normalizeForComparison(text: string): string {
  return text
    .replace(CURLY_DOUBLE, '"')
    .replace(CURLY_SINGLE, "'")
    .replace(UNICODE_DASH, '-')
    .replace(AMPERSAND, ' and ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/*
 * A span's OPENING SHAPE was tested as a drift signal and rejected. The hypothesis — that a
 * quotation beginning mid-sentence is a pairing artifact — looked right on a sample of unmatched
 * spans, but across the full distribution the three shapes match at statistically the same rate:
 *
 *   punctuation/digit-leading   28 matched /  6 unmatched  (82%)
 *   lowercase-letter-leading    95 matched / 25 unmatched  (79%)
 *   uppercase-leading          294 matched / 46 unmatched  (86%)
 *
 * Quoting a clause out of the middle of a sentence is simply ordinary. Suppressing those spans
 * would have hidden real fabrications that happen to start with a lowercase word — a false negative
 * on precisely what this metric exists to catch. The genuine inch-mark debris the heuristic was
 * aimed at (`x 9`, `/4 oz., 4`) is already removed by the word floor.
 *
 * Unbalanced quote parity is kept as the sole drift signal: it is an objective structural fact
 * about the answer, not an inference from a span's appearance.
 */

/**
 * Pulls the double-quoted spans out of an answer.
 *
 * Inch marks are stripped first (see {@link INCH_MARK}); if the quote characters are still
 * unbalanced afterwards, every span from this answer is flagged, because parity is what the
 * pairing depends on and there is no way to tell which side of the imbalance a span fell on.
 */
export function extractQuotedSpans(
  answerText: string,
  options: QuotedSpanOptions = {},
): Array<{
  span: string;
  wordCount: number;
  /** The answer's quote characters did not pair up; every span from it is untrustworthy. */
  unbalancedQuotes: boolean;
}> {
  const minWords = options.minWords ?? DEFAULT_MIN_WORDS;
  if (!answerText) return [];

  const deGlyphed = answerText.replace(CURLY_DOUBLE, '"');
  const deInched = deGlyphed.replace(INCH_MARK, '$1');

  const quoteCount = (deInched.match(/"/g) ?? []).length;
  const unbalanced = quoteCount % 2 !== 0;

  const spans: Array<{ span: string; wordCount: number; unbalancedQuotes: boolean }> = [];
  const pattern = /"([^"]+)"/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(deInched)) !== null) {
    const raw = match[1]!.trim();
    const words = wordCount(raw);
    if (words < minWords) continue;
    spans.push({ span: raw, wordCount: words, unbalancedQuotes: unbalanced });
  }

  return spans;
}

type Haystack = {
  /** Chunk bodies, searchable only where the chunk text actually resolved. */
  content: Array<{ text: string; documentId: string; chunkId: string | null }>;
  /** Titles and headings, from every ref. */
  labels: Array<{
    text: string;
    source: QuotedSpanMatchSource;
    documentId: string;
    chunkId: string | null;
  }>;
  resolvedChunks: number;
  unresolvedRefs: number;
};

/**
 * Splits the retrieved refs into the two searchable surfaces.
 *
 * Chunk bodies come only from `resolution === 'resolved'` refs: unresolved text is unknown, and
 * searching it would report "not found" for material we simply could not read.
 *
 * Titles and headings are taken from **every** ref regardless of resolution, because they are not
 * joined from the corpus — they were written into the run payload at the time the answer was
 * produced. That makes them the one part of the haystack immune to the chunk-drift problem: they
 * are what the model actually saw, not what the corpus says today.
 */
function buildHaystack(contexts: readonly ResolvedContext[]): Haystack {
  const content: Haystack['content'] = [];
  const labels: Haystack['labels'] = [];
  let resolvedChunks = 0;
  let unresolvedRefs = 0;

  for (const ctx of contexts) {
    if (ctx.resolution === 'resolved' && ctx.text) {
      content.push({
        text: normalizeForComparison(ctx.text),
        documentId: ctx.document_id,
        chunkId: ctx.chunk_id,
      });
      resolvedChunks += 1;
    } else {
      unresolvedRefs += 1;
    }

    if (ctx.document_title?.trim()) {
      labels.push({
        text: normalizeForComparison(ctx.document_title),
        source: 'document_title',
        documentId: ctx.document_id,
        chunkId: ctx.chunk_id,
      });
    }
    if (ctx.heading?.trim()) {
      labels.push({
        text: normalizeForComparison(ctx.heading),
        source: 'heading',
        documentId: ctx.document_id,
        chunkId: ctx.chunk_id,
      });
    }
  }

  return { content, labels, resolvedChunks, unresolvedRefs };
}

/**
 * Scores one answer's quoted spans against the chunks retrieved for that turn.
 *
 * Content is checked before labels so that a span appearing in both is attributed to the stronger
 * claim — quoting a document's body is evidence; quoting its name is not.
 */
export function scoreQuotedSpans(
  answerText: string | null,
  contexts: readonly ResolvedContext[],
  options: QuotedSpanOptions = {},
): QuotedSpanResult {
  const haystack = buildHaystack(contexts);
  const extracted = extractQuotedSpans(answerText ?? '', options);

  const spans: QuotedSpanVerdict[] = extracted.map((candidate) => {
    const needle = normalizeForComparison(candidate.span);

    const contentHit = haystack.content.find((entry) => entry.text.includes(needle));
    const labelHit = contentHit ? null : haystack.labels.find((entry) => entry.text.includes(needle));
    const hit = contentHit ?? labelHit ?? null;

    const kind: QuotedSpanKind = contentHit ? 'content' : labelHit ? 'title' : 'unmatched';

    // Unbalanced quote characters taint every span from the answer: parity is what the pairing
    // depends on, and there is no way to tell which side of the imbalance a given span fell on.
    const pairingDriftSuspected = candidate.unbalancedQuotes;

    return {
      span: candidate.span,
      wordCount: candidate.wordCount,
      kind,
      matchedIn: contentHit ? 'chunk_text' : (labelHit?.source ?? null),
      matchedDocumentId: hit?.documentId ?? null,
      matchedChunkId: hit?.chunkId ?? null,
      pairingDriftSuspected,
    };
  });

  // Drift-suspected spans are excluded from both sides of the ratio rather than counted as
  // failures. They are an artifact of our own extraction, and charging the model for them would
  // manufacture a fabrication signal out of a parsing bug.
  const scorableSpans = spans.filter((s) => !s.pairingDriftSuspected);
  const matched = scorableSpans.filter((s) => s.kind !== 'unmatched').length;
  const contentAttempts = scorableSpans.filter((s) => s.kind !== 'title');
  const contentMatches = contentAttempts.filter((s) => s.kind === 'content').length;

  return {
    score: scorableSpans.length > 0 ? matched / scorableSpans.length : null,
    contentScore: contentAttempts.length > 0 ? contentMatches / contentAttempts.length : null,
    scorable: scorableSpans.length,
    matched,
    contentMatches,
    titleCitations: scorableSpans.filter((s) => s.kind === 'title').length,
    driftExcluded: spans.length - scorableSpans.length,
    spans,
    resolvedChunks: haystack.resolvedChunks,
    unresolvedRefs: haystack.unresolvedRefs,
  };
}

/** Run-level rollup. Items with nothing to score are excluded, not counted as zero. */
export function summarizeQuotedSpans(results: readonly QuotedSpanResult[]): {
  itemsScored: number;
  itemsWithoutSpans: number;
  meanScore: number | null;
  meanContentScore: number | null;
  totalUnmatched: number;
  totalDriftExcluded: number;
} {
  const scored = results.filter((r) => r.score !== null);
  const contentScored = results.filter((r) => r.contentScore !== null);
  const mean = (values: number[]) =>
    values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;

  return {
    itemsScored: scored.length,
    itemsWithoutSpans: results.length - scored.length,
    meanScore: mean(scored.map((r) => r.score as number)),
    meanContentScore: mean(contentScored.map((r) => r.contentScore as number)),
    totalUnmatched: results.reduce(
      (acc, r) => acc + r.spans.filter((s) => s.kind === 'unmatched' && !s.pairingDriftSuspected).length,
      0,
    ),
    totalDriftExcluded: results.reduce((acc, r) => acc + r.driftExcluded, 0),
  };
}
