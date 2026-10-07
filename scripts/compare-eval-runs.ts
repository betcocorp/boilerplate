#!/usr/bin/env -S npx tsx
/**
 * B0-824 — judgment-variance study: compare two consolidated `eval.json` files (the agent-evaluation
 * skill's schema) graded on the SAME run — Bex's run report exported via
 * `scripts/export-eval-json.ts` + the skill's `consolidate_runs.py` on one side, the desktop
 * agent-evaluation flow on the other — and print the per-case table, the rollups and the proposed
 * parity targets as Markdown. The rules live in `~/lib/tests/report/parity-compare.ts`: both sides
 * are re-scored the Bex way, so only judgment (sub-scores + concept verdicts) is being compared.
 *
 * Usage:
 *   npx tsx scripts/compare-eval-runs.ts <bex-eval.json> <desktop-eval.json> \
 *     [--out report.md] [--pass-mark 60] [--spread 10] [--review-threshold 70] \
 *     [--label-a Bex] [--label-b Desktop]
 *
 * Flags:
 *   --out <path>               Also write the Markdown to this file (directories are created).
 *   --pass-mark <n>            Pass at or above n (default: DEFAULT_PASS_MARK, 60).
 *   --spread <n>               |Δ overall| at or above which a case must be explained (default 10).
 *   --review-threshold <n>     eval_confidence at or below n joins the review queue (default 70,
 *                              DEFAULT_JUDGED_THRESHOLDS.lowConfidence — Bex's at-or-below rule).
 *   --label-a / --label-b      Column labels for the two sides (default Bex / Desktop).
 *
 * Offline: no network, no database, no env file. Exit 1 on a missing/invalid input.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  compareEvalRuns,
  DEFAULT_SPREAD_THRESHOLD,
  parseEvalFile,
  renderParityMarkdown,
  type EvalFile,
} from '~/lib/tests/report/parity-compare';
import { DEFAULT_JUDGED_THRESHOLDS, DEFAULT_PASS_MARK } from '~/lib/tests/report/scoring-config';

const USAGE =
  'Usage: npx tsx scripts/compare-eval-runs.ts <bex-eval.json> <desktop-eval.json> ' +
  '[--out report.md] [--pass-mark 60] [--spread 10] [--review-threshold 70] [--label-a Bex] [--label-b Desktop]';

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} needs a value.\n${USAGE}`);
      }
      flags.set(arg, value);
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  const numberFlag = (flag: string, fallback: number): number => {
    const raw = flags.get(flag);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${flag} must be a number, got "${raw}".`);
    return value;
  };
  if (positional.length !== 2) {
    throw new Error(`Expected exactly two input files, got ${positional.length}.\n${USAGE}`);
  }
  return {
    fileA: positional[0],
    fileB: positional[1],
    out: flags.get('--out') ?? null,
    passMark: numberFlag('--pass-mark', DEFAULT_PASS_MARK),
    spreadThreshold: numberFlag('--spread', DEFAULT_SPREAD_THRESHOLD),
    reviewThreshold: numberFlag('--review-threshold', DEFAULT_JUDGED_THRESHOLDS.lowConfidence),
    labelA: flags.get('--label-a') ?? 'Bex',
    labelB: flags.get('--label-b') ?? 'Desktop',
  };
}

async function loadEvalFile(file: string, labelText: string): Promise<EvalFile> {
  const resolved = path.resolve(process.cwd(), file);
  const text = await readFile(resolved, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`${labelText}: ${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
  const parsed = parseEvalFile(json);
  if (!parsed.ok) {
    throw new Error(`${labelText}: ${file} does not match the eval.json schema:\n  ${parsed.issues.join('\n  ')}`);
  }
  return parsed.data;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [a, b] = await Promise.all([
    loadEvalFile(options.fileA, options.labelA),
    loadEvalFile(options.fileB, options.labelB),
  ]);

  const result = compareEvalRuns(a, b, {
    passMark: options.passMark,
    spreadThreshold: options.spreadThreshold,
    reviewThreshold: options.reviewThreshold,
    labelA: options.labelA,
    labelB: options.labelB,
  });
  const markdown = renderParityMarkdown(result);
  console.log(markdown);

  if (options.out) {
    const outPath = path.resolve(process.cwd(), options.out);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${markdown}\n`, 'utf8');
    console.error(`Wrote ${options.out}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
