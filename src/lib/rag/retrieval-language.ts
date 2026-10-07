import { z } from 'zod';

/**
 * B0-804 — single source of truth for the language of the *retrievable* corpus.
 *
 * WHY THE CORPUS IS ENGLISH-ONLY
 * ------------------------------
 * Bex answers regulated questions (SDS hazard data, EPA-registered label claims,
 * dilution ratios, contact times) by quoting retrieved document text back to the user.
 * Every prompt, every guardrail and every grader in this repo assumes that text is
 * English. A French or Spanish SDS in the candidate pool is not a translation problem —
 * it is a safety problem: the model cannot be trusted to transcribe a regulated value it
 * reached through an unverified translation, and our regulated-data rule forbids
 * inferring or converting one.
 *
 * The invariant is enforced at four layers, and this module is the TypeScript layer:
 *   1. `rag.document.language_code` records the *detected* language of the body
 *      (B0-794 corrected 364 SDS rows whose metadata said EN while the body was not).
 *   2. All four retrieval RPCs — `rag.match_corpus_chunks`,
 *      `rag.match_corpus_chunks_hybrid`, `rag.match_product_chunks`,
 *      `rag.match_product_chunks_hybrid` — require `upper(d.language_code) = 'EN'`
 *      AND `sr.is_active = true`, so a non-English chunk can never be *returned*.
 *   3. The `rag.sync_*_chunks` functions refuse a non-EN `p_language_code`
 *      (B0-804 migration `20260902191000_guard_non_english_chunk_sync_b0804.sql`), so a
 *      non-English document is never chunked or embedded in the first place — layer 2
 *      alone is not enough, because `match_corpus_chunks` and the fast branch of
 *      `match_corpus_chunks_hybrid` draw their top-N nearest neighbours BEFORE applying
 *      the language filter, so foreign-language vectors silently consume candidate slots
 *      and dilute English recall even while never being returned.
 *   4. B0-543 additionally drops non-English *sections* inside an otherwise-English
 *      bilingual label at assembly time (`~/lib/retrieval/document-assembly.ts`).
 *
 * THIS IS A POLICY CHOKEPOINT, NOT A TUNABLE FLAG.
 * Deliberately NOT a `public.settings` row: it is an invariant of the retrieval design,
 * not something to be toggled per environment. Widening `RETRIEVAL_LANGUAGE_CODES` means
 * re-deciding the `match_*` RPC language filters (layer 2) and the `sync_*` guards
 * (layer 3) at the same time — changing this constant alone would let non-English
 * documents be chunked and embedded while still being unreturnable, which is the worst
 * of both worlds. Non-English documents remain fully visible and inspectable in the
 * admin UI; only the *retrievable* corpus is constrained.
 */
export const RETRIEVAL_LANGUAGE_CODES = ['EN'] as const;

export type RetrievalLanguageCode = (typeof RETRIEVAL_LANGUAGE_CODES)[number];

/** The language a corpus operation runs against when the caller supplies nothing. */
export const RETRIEVAL_LANGUAGE_CODE: RetrievalLanguageCode = 'EN';

/**
 * Validates an already-normalized (trimmed, upper-cased) language code against the
 * retrievable-corpus allow-list. Use `normalizeRetrievalLanguageCode` for raw input.
 */
export const retrievalLanguageCodeSchema = z.enum(RETRIEVAL_LANGUAGE_CODES);

/**
 * Normalize raw caller input (form field, query string, RPC option) to a language code
 * the retrievable corpus actually supports.
 *
 * Blank / missing input defaults to `RETRIEVAL_LANGUAGE_CODE` — that is the pre-existing
 * behaviour of every call site and must not change. Anything else is trimmed and
 * upper-cased, then checked against the allow-list.
 *
 * Returns a discriminated result rather than throwing, so server actions can surface the
 * rejection through their own `ActionState` error path; `assertRetrievalLanguageCode`
 * wraps this for call sites that should throw instead.
 */
export function normalizeRetrievalLanguageCode(
  raw: unknown,
):
  | { ok: true; languageCode: RetrievalLanguageCode }
  | { ok: false; requested: string; error: string } {
  if (raw === null || raw === undefined) {
    return { ok: true, languageCode: RETRIEVAL_LANGUAGE_CODE };
  }

  if (typeof raw !== 'string') {
    return {
      ok: false,
      requested: String(raw),
      error: unsupportedLanguageMessage(String(raw)),
    };
  }

  const candidate = raw.trim().toUpperCase();
  if (!candidate) {
    return { ok: true, languageCode: RETRIEVAL_LANGUAGE_CODE };
  }

  const parsed = retrievalLanguageCodeSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, requested: candidate, error: unsupportedLanguageMessage(candidate) };
  }

  return { ok: true, languageCode: parsed.data };
}

/**
 * Throwing variant of `normalizeRetrievalLanguageCode`, for non-action call sites
 * (pipeline runs, API handlers) whose convention is to surface failures as thrown errors.
 */
export function assertRetrievalLanguageCode(raw: unknown): RetrievalLanguageCode {
  const result = normalizeRetrievalLanguageCode(raw);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.languageCode;
}

/**
 * True when a stored `rag.document.language_code` belongs to the retrievable corpus.
 * A null/blank stored value is treated as NOT retrievable: an unknown language is never
 * assumed to be English (regulated data — unreadable means say so, never guess).
 */
export function isRetrievableLanguageCode(languageCode: unknown): boolean {
  return (
    typeof languageCode === 'string' &&
    retrievalLanguageCodeSchema.safeParse(languageCode.trim().toUpperCase()).success
  );
}

function unsupportedLanguageMessage(requested: string): string {
  const allowed = RETRIEVAL_LANGUAGE_CODES.join(', ');
  return `B0-804: language code "${requested}" is not part of the retrievable corpus. Bex retrieval is ${allowed}-only — chunking or embedding another language would put untranslated regulated text into the candidate pool (see B0-794, B0-543). Leave the language blank to use ${RETRIEVAL_LANGUAGE_CODE}.`;
}
