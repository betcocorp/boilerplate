#!/usr/bin/env -S npx tsx
/**
 * B0-97 — calibration harness for the cross-reference answer gate
 * (`XREF_RECOMMENDATION_MIN_CONFIDENCE`, `gateRecommendation` in
 * `~/lib/recommendations/confidence-scoring`).
 *
 * The gate's threshold has never been chosen from data. This script produces the data.
 *
 * ## Why a harvest step is needed at all
 *
 * `recommendCrossReference()` short-circuits on a confident legacy match and never reaches the
 * gate, so the two paths are mutually exclusive: every competitor product with a curated answer in
 * `legacy.competitor_products` is answered WITHOUT scoring, and every product that reaches the gate
 * has, by construction, no curated answer to check it against. Confirmed live (2026-09-02): of 327
 * historical web-path rows in `rag.cross_reference_recommendations`, exactly 1 has a legacy
 * counterpart. So the gate cannot be calibrated from historical rows alone.
 *
 * `--harvest` breaks that deadlock without inventing any product data. It takes competitor products
 * that DO have a curated Betco equivalent, injects a deliberately-missing legacy lookup so the
 * engine is forced down the web-grounded path, and then labels the web path's top candidate by
 * comparing its `betcoProductKey` to the curated `ProductKey`. The label comes from Betco's own
 * cross-reference table — it is not guessed, and no equivalence is authored here.
 *
 * ## Usage
 *
 *   # 1. Harvest labeled (confidence, correct) pairs — costs web searches + LLM calls.
 *   npx tsx --env-file=.env.local scripts/calibrate-xref-threshold.ts --harvest --limit 40
 *
 *   # 2. Print the precision/recall/F1 curve from everything labeled so far.
 *   npx tsx --env-file=.env.local scripts/calibrate-xref-threshold.ts
 *
 * Flags:
 *   --harvest              Run the forced-web-path harvest before reporting.
 *   --limit <n>            Harvest sample size (default 40).
 *   --seed <n>             Deterministic sample selection (default 97).
 *   --cases <path>         Harvest case file (default src/lib/recommendations/eval/xref-threshold-cases.json).
 *   --min-precision <p>    Precision target for threshold selection (default 0.90).
 *   --min-labeled <n>      Minimum labeled answered cases before a threshold may be recommended (default 20).
 *   --concurrency <n>      Parallel harvest runs (default 4).
 *
 * This script NEVER writes to `rag.cross_reference_recommendations` (the engine does not persist;
 * persistence is `persist-recommendation.ts`, which is not called here) and NEVER changes the live
 * threshold. It prints a recommendation; a human sets the value.
 */

import { createClient } from '@supabase/supabase-js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ThresholdCalibrationCase } from '~/lib/recommendations/eval/threshold-calibration';
import {
  recommendCrossReference,
  type RecommendCrossReferenceDeps,
} from '~/lib/recommendations/recommend-cross-reference';
import { retrieveBetcoCandidates } from '~/lib/recommendations/candidate-retrieval';
import { filterGroundedCandidates } from '~/lib/recommendations/recommendation-guardrails';
import { runRecommendationWebSearch } from '~/lib/recommendations/recommendation-web-search';
import { enrichCompetitorSpec } from '~/lib/websearch/enrich-competitor-spec';
import { runValidatorPass } from '~/lib/workflows/product-support/validator';

const DEFAULT_CASES_PATH = 'src/lib/recommendations/eval/xref-threshold-cases.json';

type HarvestedCase = ThresholdCalibrationCase & {
  competitorBrand: string | null;
  competitorProduct: string;
  /** Curated Betco product key from `legacy.competitor_products` — the ground truth. */
  expectedProductKey: string;
  actualProductKey: string | null;
  actualTitle: string | null;
  source: 'legacy' | 'web';
  harvestedAt: string;
  /** Why `correct` is what it is, so a reviewer can audit a label without re-running. */
  labelBasis: string;
};

function parseArgs(argv: string[]) {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
  };
  return {
    harvest: argv.includes('--harvest'),
    limit: Number(get('--limit') ?? 40),
    seed: Number(get('--seed') ?? 97),
    casesPath: get('--cases') ?? DEFAULT_CASES_PATH,
    minPrecision: Number(get('--min-precision') ?? 0.9),
    minLabeled: Number(get('--min-labeled') ?? 20),
    concurrency: Number(get('--concurrency') ?? 4),
  };
}

function supabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (use --env-file=.env.local).',
    );
  }
  return createClient(url, key);
}

/** Deterministic 0–1 hash so the same --seed always picks the same sample. */
function seededScore(key: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < key.length; i += 1) {
    h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h / 0xffffffff;
}

/**
 * Deps that force the web-grounded path: `lookupInternal` reports a legacy miss in exactly the
 * shape `cross-reference-lookup.ts` returns when no competitor product key matches, so the engine
 * takes step 2 without any change to production code. `lookupInternalCached` is deliberately
 * omitted — the engine prefers it when present and it would re-enter the real legacy lookup.
 */
function forcedWebPathDeps(): RecommendCrossReferenceDeps {
  return {
    lookupInternal: async (input) => ({
      ok: true,
      adapter: 'legacy_cross_reference_v1',
      input: { brand: input.brand, productName: input.productName },
      normalizedInput: { brand: input.brand, productName: input.productName },
      brandCandidates: [] as string[],
      totalCandidates: 0,
      fallbackRecommended: true,
      matches: [],
    }),
    searchWeb: (input) => runRecommendationWebSearch(input),
    enrich: (input) => enrichCompetitorSpec(input),
    retrieve: (input) => retrieveBetcoCandidates(input),
    filterGrounded: (candidates) => filterGroundedCandidates(candidates),
    validate: (input) => runValidatorPass(input),
  };
}

const normalizeKey = (value: string | null | undefined): string =>
  (value ?? '').trim().toUpperCase();

async function harvest(options: ReturnType<typeof parseArgs>): Promise<HarvestedCase[]> {
  const supabase = supabaseClient();

  const { data, error } = await supabase
    .schema('legacy')
    .from('competitor_products')
    .select('ProductDescr, Competitor, ProductKey')
    .not('ProductKey', 'is', null)
    .limit(1000);

  if (error) throw new Error(`legacy.competitor_products read failed: ${error.message}`);

  // `competitor_products.Competitor` is a CompetitorID, NOT a brand name — feeding the raw id to
  // the engine sends "24 First Step Floor Sealer" to web search and invalidates the whole harvest.
  // Resolve it through `legacy.competitor` so the engine sees "Misco".
  const { data: competitorRows, error: competitorError } = await supabase
    .schema('legacy')
    .from('competitor')
    .select('Competitor, CompetitorID');

  if (competitorError) {
    throw new Error(`legacy.competitor read failed: ${competitorError.message}`);
  }
  const brandById = new Map<string, string>(
    (competitorRows ?? [])
      .filter((r) => r.CompetitorID != null && typeof r.Competitor === 'string')
      .map((r) => [String(r.CompetitorID), String(r.Competitor).trim()]),
  );

  const pool = (data ?? [])
    .filter((r) => typeof r.ProductDescr === 'string' && r.ProductDescr.trim().length > 0)
    // A row whose competitor id does not resolve to a brand name is dropped rather than harvested
    // brandless: `brandKnown: false` applies a 0.9 penalty and would bias the curve downward.
    .filter((r) => brandById.has(String(r.Competitor)));
  const sample = [...pool]
    .sort(
      (a, b) =>
        seededScore(`${a.Competitor}|${a.ProductDescr}`, options.seed) -
        seededScore(`${b.Competitor}|${b.ProductDescr}`, options.seed),
    )
    .slice(0, options.limit);

  console.log(
    `Harvesting ${sample.length} forced-web-path runs (pool ${pool.length}, seed ${options.seed})…`,
  );

  const deps = forcedWebPathDeps();
  const results: HarvestedCase[] = [];
  let index = 0;

  async function worker() {
    for (;;) {
      const i = index;
      index += 1;
      if (i >= sample.length) return;
      const row = sample[i]!;
      const product = String(row.ProductDescr).trim();
      const brand = brandById.get(String(row.Competitor)) ?? null;
      try {
        const result = await recommendCrossReference(
          { competitorProduct: product, competitorBrand: brand },
          deps,
        );
        const top = result.candidates.find((c) => c.rank === 1) ?? result.candidates[0] ?? null;
        const expected = normalizeKey(String(row.ProductKey));
        const actual = normalizeKey(top?.betcoProductKey);
        const correct = actual.length > 0 ? actual === expected : null;

        results.push({
          id: `${brand ?? 'unknown'}::${product}`,
          overallConfidence: result.overallConfidence,
          correct,
          competitorBrand: brand,
          competitorProduct: product,
          expectedProductKey: expected,
          actualProductKey: top?.betcoProductKey ?? null,
          actualTitle: top?.betcoTitle ?? null,
          source: result.source,
          harvestedAt: new Date().toISOString(),
          labelBasis:
            actual.length === 0
              ? 'No candidate returned — unlabeled, counts toward coverage only.'
              : `Top candidate productKey ${actual} vs curated legacy.competitor_products ProductKey ${expected}.`,
        });
        console.log(
          `  [${results.length}/${sample.length}] ${brand ?? '—'} / ${product} → ` +
            `conf ${result.overallConfidence} ${correct === null ? 'UNLABELED' : correct ? 'CORRECT' : 'WRONG'}`,
        );
      } catch (error) {
        console.warn(`  ! ${brand ?? '—'} / ${product}: ${(error as Error).message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  return results;
}

/**
 * Human-verified rows from the live review queue (B0-95/96). `status = 'verified'` plus an
 * `evidence.verification.verifier` is a real reviewer verdict and is the only human ground truth
 * this system currently holds for the web-grounded gate.
 */
async function loadReviewedCases(): Promise<ThresholdCalibrationCase[]> {
  const supabase = supabaseClient();
  const { data, error } = await supabase
    .schema('rag')
    .from('cross_reference_recommendations')
    .select('id, status, overall_confidence, evidence')
    .eq('status', 'verified');

  if (error) {
    console.warn(`! could not read reviewed recommendations: ${error.message}`);
    return [];
  }

  return (data ?? [])
    .filter((row) => {
      const verification = (row.evidence as { verification?: { verifier?: string } } | null)
        ?.verification;
      return Boolean(verification?.verifier);
    })
    .map((row) => ({
      id: `reviewed:${row.id}`,
      overallConfidence: Number(row.overall_confidence),
      correct: true as const,
    }));
}

async function printCurve(
  cases: ThresholdCalibrationCase[],
  options: ReturnType<typeof parseArgs>,
) {
  const labeled = cases.filter((c) => c.correct !== null).length;
  console.log(`\nCases: ${cases.length} total, ${labeled} carrying a correctness label.`);

  if (cases.length === 0) {
    console.log('No cases available — run with --harvest first.');
    return;
  }

  // Imported at point of use: the harvest pulls in the whole engine module graph first, and a
  // static import of this small pure module has been observed resolving to a partially-initialized
  // namespace under tsx's CJS interop in that ordering.
  const { buildThresholdSweep, computeThresholdCalibration, selectThreshold } = await import(
    '~/lib/recommendations/eval/threshold-calibration'
  );

  const rows = computeThresholdCalibration(cases, buildThresholdSweep(0.7, 0.9, 0.01));
  console.log(
    '\nthreshold  answered  coverage  labeled  correct  FP  FN  precision  recall  f1',
  );
  for (const r of rows) {
    const fmt = (v: number | null) => (v === null ? '   —  ' : v.toFixed(3));
    console.log(
      `   ${r.threshold.toFixed(2)}    ${String(r.answered).padStart(5)}    ` +
        `${r.coverage.toFixed(3)}   ${String(r.labeledAnswered).padStart(5)}   ` +
        `${String(r.correctAnswered).padStart(5)}  ${String(r.falsePositives).padStart(2)}  ` +
        `${String(r.falseNegatives).padStart(2)}     ${fmt(r.precision)}  ${fmt(r.recall)}  ${fmt(r.f1)}`,
    );
  }

  const selection = selectThreshold(rows, {
    minPrecision: options.minPrecision,
    minLabeledAnswered: options.minLabeled,
  });
  console.log('');
  if (selection.chosen) {
    console.log(
      `RECOMMENDED THRESHOLD: ${selection.threshold} ` +
        `(precision ${selection.row.precision}, recall ${selection.row.recall}, ` +
        `n=${selection.labeledAnswered} labeled answered)`,
    );
  } else {
    console.log(`NO THRESHOLD RECOMMENDED: ${selection.reason}`);
    console.log(
      `Harvest more labeled pairs: npx tsx --env-file=.env.local ${path.relative(process.cwd(), process.argv[1] ?? '')} --harvest --limit 60`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const casesFile = path.resolve(process.cwd(), options.casesPath);

  let harvested: HarvestedCase[] = [];
  try {
    harvested = JSON.parse(await readFile(casesFile, 'utf8')) as HarvestedCase[];
  } catch {
    harvested = [];
  }

  if (options.harvest) {
    const fresh = await harvest(options);
    const byId = new Map(harvested.map((c) => [c.id, c]));
    for (const c of fresh) byId.set(c.id, c);
    harvested = [...byId.values()];
    await mkdir(path.dirname(casesFile), { recursive: true });
    await writeFile(casesFile, `${JSON.stringify(harvested, null, 2)}\n`, 'utf8');
    console.log(`\nWrote ${harvested.length} cases to ${options.casesPath}`);
  }

  const reviewed = await loadReviewedCases();
  console.log(`Human-reviewed cases from the live review queue: ${reviewed.length}`);

  await printCurve([...harvested, ...reviewed], options);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
