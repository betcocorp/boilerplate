#!/usr/bin/env -S npx tsx
/**
 * Data-gap audit prototype (deep dive: "Identification and surfacing of data gaps identified
 * through runs", Confluence 268238849).
 *
 * For every item in an eval run whose run-time concept score is below the threshold, and for every
 * concept the grader marked `met: false`, this script asks the corpus three questions the harness
 * cannot answer today:
 *
 *   1. Does ANY chunk in the corpus support the concept? (unfiltered hybrid search, then an LLM
 *      verifier that must return a verbatim quote, which is checked as a literal substring of
 *      `chunk_text` — no substring, no credit)
 *   2. Was a supporting chunk among the chunks the run actually retrieved?
 *   3. If not, was a sibling chunk of the same document retrieved, or was the document never seen?
 *
 * and turns the answers into one class per concept:
 *
 *   retrieved_not_used  — supporting chunk WAS retrieved; the gap is generation/guardrail (code side)
 *   sibling_chunk_gap   — same document retrieved, supporting chunk was not (chunking/window)
 *   retrieval_miss      — supporting chunk exists in a document the run never retrieved
 *   corpus_gap          — no verified support anywhere in the corpus (ingestion candidate)
 *
 * Read-only against the database (the only write is the search-embedding cache that
 * `searchProductChunks` already maintains for every query). Outputs JSON + CSV to --out.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/data-gap-audit.ts --run <test_result_id> [--run ...]
 *   npx tsx --env-file=.env.local scripts/data-gap-audit.ts --golden-latest
 * Flags:
 *   --threshold <n>   score cut-off (0-100). Default: settings row DATA_GAP_AUDIT_SCORE_THRESHOLD, else 80
 *   --item <id>       only this test_item_id
 *   --max-items <n>   cap items per run (smoke tests)
 *   --model <id>      verifier model (default gpt-4.1)
 *   --candidates <n>  chunks sent to the verifier per concept (default 12)
 *   --dry             skip the LLM verifier; classify with search hits only (plumbing check)
 *   --tag-concepts    with --annotate: classify concepts factual/behavioural (one batched LLM call per 40) and relabel behavioural corpus gaps policy_gap
 *   --annotate <json> re-apply the post-pass (support categories, cross-domain flags) to an existing output
 *   --include-all     audit every item that has a missed concept, ignoring the threshold (calibration)
 *   --no-report-fallback  do not read missed concepts from report_state.caseScores for items lacking criteriaGrading
 *   --out <dir>       output directory (default ./tmp/data-gap-audit)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { completeStructuredWithUsage } from '~/lib/llm/structured-completion';
import { deriveKnowledgeCategoryFromS3Key, searchProductChunks, type RagSearchMatch } from '~/lib/rag/search';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

type Args = {
  runs: string[];
  goldenLatest: boolean;
  threshold: number | null;
  item: string | null;
  maxItems: number | null;
  model: string;
  candidates: number;
  dry: boolean;
  out: string;
  /** Take missed concepts from report_state.caseScores when the item has no run-time criteriaGrading (pre-4.6.0 runs). */
  /** Re-run only the post-pass (categories, cross-domain flags) over an existing JSON output and rewrite its JSON/CSV. */
  annotate: string | null;
  /** With --annotate: tag every concept factual/behavioural and relabel behavioural corpus gaps as policy_gap. */
  tagConcepts: boolean;
  reportFallback: boolean;
  /** Audit every item with a missed concept, ignoring the score threshold (calibration runs). */
  includeAll: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    runs: [],
    goldenLatest: false,
    threshold: null,
    item: null,
    maxItems: null,
    model: 'gpt-4.1',
    candidates: 12,
    dry: false,
    out: join(process.cwd(), 'tmp', 'data-gap-audit'),
    annotate: null,
    tagConcepts: false,
    reportFallback: true,
    includeAll: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--run') { a.runs.push(v); i++; }
    else if (k === '--golden-latest') a.goldenLatest = true;
    else if (k === '--threshold') { a.threshold = Number(v); i++; }
    else if (k === '--item') { a.item = v; i++; }
    else if (k === '--max-items') { a.maxItems = Number(v); i++; }
    else if (k === '--model') { a.model = v; i++; }
    else if (k === '--candidates') { a.candidates = Number(v); i++; }
    else if (k === '--dry') a.dry = true;
    else if (k === '--no-report-fallback') a.reportFallback = false;
    else if (k === '--include-all') a.includeAll = true;
    else if (k === '--annotate') { a.annotate = v; i++; }
    else if (k === '--tag-concepts') a.tagConcepts = true;
    else if (k === '--out') { a.out = v; i++; }
  }
  return a;
}

// ---------- types ----------

type Verdict = { concept: string; tier: number; met: boolean; evidence: string; criterionIndex: number };
type ChunkRef = { document_id: string; chunk_id: string | null; document_kind?: string | null; document_title?: string | null; product_line_key?: string | null };

type ItemRow = {
  id: string;
  test_result_id: string;
  test_item_id: string;
  row_index: number;
  passed: boolean | null;
  answer_provenance: string | null;
  response_payload: Record<string, unknown> | null;
  test_items: { prompt: string; test_id: string; tests: { name: string } | null } | null;
};

export type ConceptClass = 'retrieved_not_used' | 'sibling_chunk_gap' | 'retrieval_miss' | 'corpus_gap' | 'policy_gap';
/** factual = a statement the corpus could carry; behavioural = how Bex should behave (ask, offer, defer, cite, recommend a rep). */
export type ConceptKind = 'factual' | 'behavioural';

type SupportingChunk = {
  chunk_id: string;
  document_id: string;
  document_title: string;
  document_kind: string;
  product_line_key: string | null;
  similarity: number;
  quote: string;
  quote_check: QuoteCheck;
  /** B0-780 knowledge category folder (vct, sportszone, restroom, dilution-control, product, …); null for non-knowledge docs. */
  category: string | null;
  /** True when the support comes from another specialist's knowledge folder than the golden set's domain. */
  cross_domain: boolean;
};

type ConceptResult = {
  run_id: string;
  test_result_item_id: string;
  test_item_id: string;
  golden_set: string;
  row_index: number;
  prompt: string;
  answer_provenance: string | null;
  run_score: number | null;
  concept: string;
  tier: number;
  class: ConceptClass;
  lock_key: string | null;
  lock_excluded: boolean;
  candidates_searched: number;
  candidates_verified: number;
  top_similarity: number | null;
  support: SupportingChunk[];
  retrieved_chunk_count: number;
  verifier_model: string | null;
  concept_source: 'run' | 'report' | 'none';
  /** Set by the --tag-concepts post-pass. */
  concept_kind?: ConceptKind;
  notes: string[];
};

// ---------- helpers ----------

/**
 * Quote verification. Chunk text is markdown with bold markers, backslash line continuations,
 * list dashes and pipe tables; the verifier model strips that noise when it copies a passage. So
 * both sides are reduced to an alphanumeric skeleton (letters, digits, spaces; U+FFFD and all
 * punctuation become spaces) before the substring test. Digits are kept as-is so a regulated value
 * such as "1:32" still has to match "1 32" on both sides — the skeleton never changes a number.
 *
 * Two tiers: `verbatim` = skeleton substring; `fuzzy` = at least 90% of the quote's word 3-grams
 * occur in the chunk skeleton (tolerates one dropped or reordered token in a long quote). Anything
 * below that is rejected and recorded in `notes`, so the rejection rate stays visible.
 */
const skeleton = (s: string) =>
  s
    .replace(/\uFFFD/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

type QuoteCheck = 'verbatim' | 'fuzzy' | 'rejected';

function checkQuote(quote: string, chunkText: string): QuoteCheck {
  const q = skeleton(quote);
  if (q.length < 12) return 'rejected';
  const c = skeleton(chunkText);
  if (c.includes(q)) return 'verbatim';
  const words = q.split(' ');
  if (words.length < 4) return 'rejected';
  const grams: string[] = [];
  for (let i = 0; i + 3 <= words.length; i++) grams.push(words.slice(i, i + 3).join(' '));
  const hit = grams.filter((g) => c.includes(g)).length;
  return hit / grams.length >= 0.9 ? 'fuzzy' : 'rejected';
}

async function resolveThreshold(explicit: number | null): Promise<{ value: number; source: string }> {
  if (explicit != null && Number.isFinite(explicit)) return { value: explicit, source: 'flag' };
  try {
    const { getNumberSetting } = await import('~/lib/settings/settings-service');
    const v = await getNumberSetting('DATA_GAP_AUDIT_SCORE_THRESHOLD', 80);
    return { value: v, source: v === 80 ? 'settings-or-default' : 'settings' };
  } catch (e) {
    return { value: 80, source: `default (settings read failed: ${e instanceof Error ? e.message : String(e)})` };
  }
}

async function latestGoldenRuns(): Promise<string[]> {
  const sb = getSupabaseServiceRoleClient();
  const { data: tests, error } = await sb.from('tests').select('id, name').eq('is_golden', true).eq('is_archived', false);
  if (error) throw error;
  const ids: string[] = [];
  for (const t of tests ?? []) {
    const { data } = await sb
      .from('test_results')
      .select('id, completed_at, status')
      .eq('test_id', t.id)
      .in('status', ['completed', 'completed_with_failures'])
      .order('completed_at', { ascending: false })
      .limit(1);
    if (data?.[0]) ids.push(data[0].id);
  }
  return ids;
}

type ReportCaseConcepts = { mandatory?: { missing?: string[] }; expected?: { missing?: string[] } };

async function loadReportConcepts(runId: string): Promise<Map<string, ReportCaseConcepts>> {
  const sb = getSupabaseServiceRoleClient();
  const { data } = await sb.from('test_results').select('report_state').eq('id', runId).maybeSingle();
  const out = new Map<string, ReportCaseConcepts>();
  const cases = (data?.report_state as { caseScores?: Record<string, { concepts?: ReportCaseConcepts | null }> } | null)?.caseScores ?? {};
  for (const [itemId, cs] of Object.entries(cases)) if (cs?.concepts) out.set(itemId, cs.concepts);
  return out;
}

async function loadRunItems(runId: string): Promise<ItemRow[]> {
  const sb = getSupabaseServiceRoleClient();
  const { data, error } = await sb
    .from('test_result_items')
    .select('id, test_result_id, test_item_id, row_index, passed, answer_provenance, response_payload, test_items(prompt, test_id, tests(name))')
    .eq('test_result_id', runId)
    .order('row_index', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as ItemRow[];
}

function runScore(payload: Record<string, unknown> | null): number | null {
  const cg = payload?.criteriaGrading as { score?: number } | undefined;
  return typeof cg?.score === 'number' ? Math.round(cg.score * 1000) / 10 : null;
}

function missedVerdicts(payload: Record<string, unknown> | null, report?: ReportCaseConcepts): { verdicts: Verdict[]; source: 'run' | 'report' | 'none' } {
  const cg = payload?.criteriaGrading as { verdicts?: Verdict[] } | undefined;
  if (cg?.verdicts) {
    return { verdicts: cg.verdicts.filter((v) => v && v.met === false && typeof v.concept === 'string'), source: 'run' };
  }
  if (report) {
    const verdicts: Verdict[] = [];
    (report.mandatory?.missing ?? []).forEach((c, i) => verdicts.push({ concept: c, tier: 1, met: false, evidence: '', criterionIndex: i }));
    (report.expected?.missing ?? []).forEach((c, i) => verdicts.push({ concept: c, tier: 2, met: false, evidence: '', criterionIndex: 100 + i }));
    return { verdicts, source: 'report' };
  }
  return { verdicts: [], source: 'none' };
}

function retrievedRefs(payload: Record<string, unknown> | null): { chunks: Set<string>; docs: Set<string>; count: number } {
  const chunks = new Set<string>();
  const docs = new Set<string>();
  const refs = (payload?.retrieved_document_chunks as ChunkRef[] | undefined) ?? [];
  for (const r of refs) {
    if (r.document_id) docs.add(r.document_id);
    if (r.chunk_id) chunks.add(r.chunk_id);
  }
  // `sources[]` carries the same ids under camelCase (plus synthetic facts entries); union them.
  const sources = (payload?.sources as Array<{ documentId?: string; chunkId?: string }> | undefined) ?? [];
  for (const s of sources) {
    if (s.documentId) docs.add(s.documentId);
    if (s.chunkId) chunks.add(s.chunkId);
  }
  return { chunks, docs, count: refs.length };
}

function lockKey(payload: Record<string, unknown> | null): string | null {
  const lock = payload?.productLineLock as { lockedProductLineKey?: string | null } | undefined;
  return lock?.lockedProductLineKey ?? null;
}

async function searchCandidates(prompt: string, concept: string): Promise<RagSearchMatch[]> {
  const queries = [concept, `${prompt}\n${concept}`];
  const seen = new Map<string, RagSearchMatch>();
  for (const q of queries) {
    try {
      const res = await searchProductChunks({
        query: q,
        limit: 20,
        scope: 'all',
        useHybrid: true,
        useReranker: false,
        useMultiIntent: false,
        minSimilarity: 0,
      });
      for (const m of res.matches) {
        const prev = seen.get(m.chunk_id);
        if (!prev || m.similarity > prev.similarity) seen.set(m.chunk_id, m);
      }
    } catch (e) {
      console.warn(`  search failed for "${q.slice(0, 60)}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return [...seen.values()].sort((a, b) => b.similarity - a.similarity);
}

const VERIFIER_SYSTEM = `You are auditing a retrieval corpus for a cleaning-chemicals company. You are given one REQUIRED CONCEPT (a short phrase a correct answer to a user's question had to state) and several CANDIDATE CHUNKS from the corpus.

For EACH candidate decide whether the chunk, on its own, contains the information needed to state the concept. Be strict: the chunk must actually carry the substance of the concept, not merely mention the topic. Paraphrase in the chunk is fine; the concept does not have to appear word for word.

When a chunk supports the concept, copy the single most relevant passage from that chunk VERBATIM into "quote" — an exact, character-for-character excerpt of at least 12 characters, no ellipses, no paraphrase, no added words. If the chunk does not support the concept, set supports=false and quote="".

Regulated-data rule: never alter numbers, units, ratios, percentages, contact times or registration numbers when quoting.

Return ONLY the JSON object.`;

const VERIFIER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          candidate_index: { type: 'integer' },
          supports: { type: 'boolean' },
          quote: { type: 'string' },
        },
        required: ['candidate_index', 'supports', 'quote'],
      },
    },
  },
  required: ['verdicts'],
} as const;

type VerifierOut = { verdicts: Array<{ candidate_index: number; supports: boolean; quote: string }> };

async function verify(model: string, prompt: string, concept: string, cands: RagSearchMatch[]): Promise<Map<string, { supports: boolean; quote: string }>> {
  const out = new Map<string, { supports: boolean; quote: string }>();
  if (cands.length === 0) return out;
  const user = [
    `USER QUESTION: ${prompt}`,
    `REQUIRED CONCEPT: ${concept}`,
    '',
    'CANDIDATE CHUNKS:',
    ...cands.map((c, i) => `--- candidate_index ${i} | ${c.document_kind} | ${c.document_title} ---\n${c.chunk_text.slice(0, 2400)}`),
  ].join('\n');
  const res = await completeStructuredWithUsage({
    model,
    system: VERIFIER_SYSTEM,
    user,
    schemaName: 'data_gap_verifier',
    schema: VERIFIER_SCHEMA as unknown as Record<string, unknown>,
    maxOutputTokens: 4000,
    temperature: 0,
  });
  let parsed: VerifierOut;
  try {
    parsed = JSON.parse(res.text) as VerifierOut;
  } catch {
    console.warn('  verifier returned non-JSON; treating as no support');
    return out;
  }
  for (const v of parsed.verdicts ?? []) {
    const c = cands[v.candidate_index];
    if (c) out.set(c.chunk_id, { supports: !!v.supports, quote: v.quote ?? '' });
  }
  return out;
}

function classify(
  support: SupportingChunk[],
  retrieved: { chunks: Set<string>; docs: Set<string> },
  lock: string | null,
): { cls: ConceptClass; lockExcluded: boolean } {
  if (support.length === 0) return { cls: 'corpus_gap', lockExcluded: false };
  if (support.some((s) => retrieved.chunks.has(s.chunk_id))) return { cls: 'retrieved_not_used', lockExcluded: false };
  if (support.some((s) => retrieved.docs.has(s.document_id))) return { cls: 'sibling_chunk_gap', lockExcluded: false };
  const lockExcluded = !!lock && support.every((s) => s.product_line_key !== lock);
  return { cls: 'retrieval_miss', lockExcluded };
}

/** Golden-set name → B0-780 knowledge category. Null when the set has no single specialist domain. */
function setDomain(setName: string): string | null {
  const n = setName.toLowerCase();
  if (n.includes('vct')) return 'vct';
  if (n.includes('sportszone') || n.includes('sports zone') || n.includes('wood')) return 'sportszone';
  if (n.includes('restroom')) return 'restroom';
  if (n.includes('dilution')) return 'dilution-control';
  if (n.includes('product')) return 'product';
  return null;
}

/** Categories every specialist may draw on (see the B0-780 note on `excludeKnowledgeCategories`). */
const CROSS_CUTTING_CATEGORIES = new Set(['dilution-control', 'product']);

async function loadDocumentCategories(documentIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = [...new Set(documentIds)];
  const sb = getSupabaseServiceRoleClient();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.schema('rag').from('document').select('id, document_kind, metadata').in('id', ids.slice(i, i + 200));
    for (const row of data ?? []) {
      const s3Key = (row.metadata as { s3_key?: string } | null)?.s3_key ?? null;
      out.set(row.id, row.document_kind === 'knowledge' ? deriveKnowledgeCategoryFromS3Key(s3Key) : null);
    }
  }
  return out;
}

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.annotate) { await annotateExisting(args.annotate, args.tagConcepts, args.model); return; }
  const runs = args.goldenLatest ? await latestGoldenRuns() : args.runs;
  if (runs.length === 0) {
    console.error('Pass --run <test_result_id> (repeatable) or --golden-latest');
    process.exit(1);
  }
  const threshold = await resolveThreshold(args.threshold);
  console.log(`threshold=${threshold.value} (${threshold.source}) runs=${runs.length} model=${args.dry ? 'DRY' : args.model}`);

  const results: ConceptResult[] = [];
  const itemSummaries: Array<Record<string, unknown>> = [];

  for (const runId of runs) {
    const items = await loadRunItems(runId);
    const reportConcepts = args.reportFallback ? await loadReportConcepts(runId) : new Map<string, ReportCaseConcepts>();
    let below = items.filter((it) => {
      const s = runScore(it.response_payload);
      if (args.includeAll) return missedVerdicts(it.response_payload, reportConcepts.get(it.test_item_id)).verdicts.length > 0;
      if (s != null) return s < threshold.value;
      // No run-time score (pre-4.6.0): fall back to "has a missed concept in the report".
      return missedVerdicts(it.response_payload, reportConcepts.get(it.test_item_id)).verdicts.length > 0;
    });
    if (args.item) below = below.filter((it) => it.test_item_id === args.item);
    if (args.maxItems) below = below.slice(0, args.maxItems);
    const setName = items[0]?.test_items?.tests?.name ?? '(unknown set)';
    console.log(`\n=== run ${runId.slice(0, 8)} ${setName}: ${items.length} items, ${below.length} below ${threshold.value}`);

    for (const it of below) {
      const payload = it.response_payload;
      const prompt = it.test_items?.prompt ?? '';
      const { verdicts: missedRaw, source: conceptSource } = missedVerdicts(payload, reportConcepts.get(it.test_item_id));
      // minimum_concepts ⊆ expected_concepts, so a mandatory miss is reported twice (tier 1 and
      // tier 2). Keep one verdict per concept skeleton, preferring tier 1.
      const missed = [...missedRaw]
        .sort((a, b) => a.tier - b.tier)
        .filter((v, i, arr) => arr.findIndex((w) => skeleton(w.concept) === skeleton(v.concept)) === i);
      const retrieved = retrievedRefs(payload);
      const lock = lockKey(payload);
      const score = runScore(payload);
      console.log(`\n  #${it.row_index} score=${score} prov=${it.answer_provenance} missed=${missed.length} (${conceptSource}) retrieved_chunks=${retrieved.count} lock=${lock ?? '-'}`);
      console.log(`  ${prompt.slice(0, 110)}`);

      const classes: ConceptClass[] = [];
      for (const v of missed) {
        const cands = await searchCandidates(prompt, v.concept);
        const top = cands.slice(0, args.candidates);
        const notes: string[] = [];
        let support: SupportingChunk[] = [];
        if (args.dry) {
          // Plumbing check only: treat top-3 search hits as "support" so the set comparison runs.
          support = top.slice(0, 3).map((c) => ({
            chunk_id: c.chunk_id, document_id: c.document_id, document_title: c.document_title, document_kind: c.document_kind,
            product_line_key: c.product_line_key, similarity: c.similarity, quote: '', quote_check: 'rejected', category: null, cross_domain: false,
          }));
          notes.push('dry-run: support = top-3 search hits, unverified');
        } else {
          const verdicts = await verify(args.model, prompt, v.concept, top);
          for (const c of top) {
            const vd = verdicts.get(c.chunk_id);
            if (!vd?.supports) continue;
            const check = checkQuote(vd.quote, c.chunk_text);
            if (check === 'rejected') { notes.push(`quote rejected in ${c.chunk_id.slice(0, 8)}: "${vd.quote.slice(0, 60)}"`); continue; }
            support.push({
              chunk_id: c.chunk_id, document_id: c.document_id, document_title: c.document_title, document_kind: c.document_kind,
              product_line_key: c.product_line_key, similarity: c.similarity, quote: vd.quote, quote_check: check, category: null, cross_domain: false,
            });
          }
        }
        const { cls, lockExcluded } = classify(support, retrieved, lock);
        classes.push(cls);
        results.push({
          run_id: runId,
          test_result_item_id: it.id,
          test_item_id: it.test_item_id,
          golden_set: setName,
          row_index: it.row_index,
          prompt,
          answer_provenance: it.answer_provenance,
          run_score: score,
          concept: v.concept,
          tier: v.tier,
          class: cls,
          lock_key: lock,
          lock_excluded: lockExcluded,
          candidates_searched: cands.length,
          candidates_verified: support.length,
          top_similarity: cands[0]?.similarity ?? null,
          support,
          retrieved_chunk_count: retrieved.count,
          verifier_model: args.dry ? null : args.model,
          concept_source: conceptSource,
          notes,
        });
        const best = support[0];
        console.log(`    [t${v.tier}] ${cls}${lockExcluded ? ' (lock-excluded)' : ''}  <- "${v.concept.slice(0, 70)}"${best ? `  :: ${best.document_kind}/${best.document_title.slice(0, 50)}` : ''}`);
      }
      const tally = classes.reduce<Record<string, number>>((m, c) => ((m[c] = (m[c] ?? 0) + 1), m), {});
      itemSummaries.push({ run_id: runId, test_item_id: it.test_item_id, golden_set: setName, row_index: it.row_index, prompt, answer_provenance: it.answer_provenance, run_score: score, missed: missed.length, ...tally });
    }
  }

  await annotateAndWrite(results, itemSummaries, { threshold, runs, model: args.dry ? null : args.model }, args.out);
}

type OutputMeta = { threshold: { value: number; source: string }; runs: string[]; model: string | null };

async function annotateAndWrite(results: ConceptResult[], itemSummaries: Array<Record<string, unknown>>, meta: OutputMeta, outDir: string, basePath?: string) {
  // Post-pass: annotate every supporting document with its knowledge category and flag support that
  // comes from another specialist's domain (a VCT procedure "supporting" a wood gym floor concept).
  const categories = await loadDocumentCategories(results.flatMap((r) => r.support.map((s) => s.document_id)));
  for (const r of results) {
    const domain = setDomain(r.golden_set);
    r.notes = r.notes.filter((n) => n !== 'all support is cross-domain');
    for (const s of r.support) {
      s.category = categories.get(s.document_id) ?? null;
      s.cross_domain = !!domain && !!s.category && s.category !== domain && !CROSS_CUTTING_CATEGORIES.has(s.category) && !CROSS_CUTTING_CATEGORIES.has(domain);
    }
    if (r.support.length > 0 && r.support.every((s) => s.cross_domain)) r.notes.push('all support is cross-domain');
  }

  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = basePath ?? join(outDir, `data-gap-audit-${stamp}`);
  writeFileSync(`${base}.json`, JSON.stringify({ ...meta, results, items: itemSummaries }, null, 2));
  const cols = ['run_id', 'test_item_id', 'golden_set', 'row_index', 'prompt', 'answer_provenance', 'run_score', 'tier', 'concept', 'class', 'lock_key', 'lock_excluded', 'candidates_searched', 'candidates_verified', 'top_similarity', 'support_kind', 'support_title', 'support_chunk_id', 'support_line', 'support_category', 'cross_domain', 'quote', 'quote_check', 'concept_source', 'concept_kind', 'notes'];
  const lines = [cols.join(',')];
  for (const r of results) {
    const s = r.support[0];
    lines.push([r.run_id, r.test_item_id, r.golden_set, r.row_index, r.prompt, r.answer_provenance, r.run_score, r.tier, r.concept, r.class, r.lock_key, r.lock_excluded, r.candidates_searched, r.candidates_verified, r.top_similarity, s?.document_kind, s?.document_title, s?.chunk_id, s?.product_line_key, s?.category, s?.cross_domain, s?.quote, s?.quote_check, r.concept_source, r.concept_kind, r.notes.join(' | ')].map(csvEscape).join(','));
  }
  writeFileSync(`${base}.csv`, lines.join('\n'));

  const byClass = results.reduce<Record<string, number>>((m, r) => ((m[r.class] = (m[r.class] ?? 0) + 1), m), {});
  const crossDomain = results.filter((r) => r.notes.includes('all support is cross-domain')).length;
  console.log(`\n=== ${results.length} concept verdicts across ${itemSummaries.length} items (${crossDomain} with only cross-domain support)`);
  for (const [k, n] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${n}`);
  console.log(`\nwrote ${base}.json / .csv`);
}

const KIND_SYSTEM = `You classify short "concept" phrases from a golden answer key for a cleaning-chemicals support assistant.
factual = a statement of fact, procedure, value or product knowledge that a reference corpus (labels, SDS, knowledge base) could contain. Examples: "keep stripper wet the whole dwell (10-15 min)", "hard water can inactivate some chemistries", "Betco registers its disinfectants in every state".
behavioural = an instruction about how the assistant itself should behave in the answer: ask a clarifying question, offer to look again, defer to the label or SDS, cite a source, recommend contacting a Betco representative, refuse or caveat. Examples: "ask for the floor substrate to narrow it", "offer to check the current label", "cite the product label".
Return ONLY the JSON object.`;
const KIND_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { kinds: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { index: { type: 'integer' }, kind: { type: 'string', enum: ['factual', 'behavioural'] } }, required: ['index', 'kind'] } } },
  required: ['kinds'],
} as const;

async function tagConceptKinds(results: ConceptResult[], model: string): Promise<void> {
  const unique = [...new Map(results.map((r) => [skeleton(r.concept), r.concept])).entries()];
  const kinds = new Map<string, ConceptKind>();
  for (let i = 0; i < unique.length; i += 40) {
    const batch = unique.slice(i, i + 40);
    const res = await completeStructuredWithUsage({
      model, system: KIND_SYSTEM,
      user: batch.map(([, c], j) => `${j}. ${c}`).join('\n'),
      schemaName: 'concept_kinds', schema: KIND_SCHEMA as unknown as Record<string, unknown>, maxOutputTokens: 2000, temperature: 0,
    });
    try {
      const parsed = JSON.parse(res.text) as { kinds: Array<{ index: number; kind: ConceptKind }> };
      for (const k of parsed.kinds) { const entry = batch[k.index]; if (entry) kinds.set(entry[0], k.kind); }
    } catch { console.warn('concept-kind batch returned non-JSON'); }
  }
  let relabelled = 0;
  for (const r of results) {
    r.concept_kind = kinds.get(skeleton(r.concept)) ?? 'factual';
    if (r.class === 'policy_gap' && r.concept_kind === 'factual') r.class = 'corpus_gap';
    if (r.class === 'corpus_gap' && r.concept_kind === 'behavioural') { r.class = 'policy_gap'; relabelled++; }
  }
  const behavioural = results.filter((r) => r.concept_kind === 'behavioural').length;
  console.log(`concept kinds: ${behavioural} behavioural / ${results.length - behavioural} factual; ${relabelled} corpus_gap → policy_gap`);
}

async function annotateExisting(jsonPath: string, tag: boolean, model: string) {
  const { readFileSync } = await import('node:fs');
  const data = JSON.parse(readFileSync(jsonPath, 'utf8')) as OutputMeta & { results: ConceptResult[]; items: Array<Record<string, unknown>> };
  for (const r of data.results) { r.concept_source = r.concept_source ?? 'run'; for (const s of r.support) { s.category = s.category ?? null; s.cross_domain = s.cross_domain ?? false; } }
  if (tag) await tagConceptKinds(data.results, model);
  const base = jsonPath.replace(/\.json$/, '');
  await annotateAndWrite(data.results, data.items, { threshold: data.threshold, runs: data.runs, model: data.model }, join(base, '..'), base);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
