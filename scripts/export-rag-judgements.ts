#!/usr/bin/env -S npx tsx
/**
 * Exports `test_items.expected_sources` as the binary document-relevance judgements consumed by
 * `evals/rag/run-phase3.ts`.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/export-rag-judgements.ts <testId> --out <file.json>
 *   npx tsx --env-file=.env.local scripts/export-rag-judgements.ts <testId> --dry-run
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildJudgementsFromExpectedSources } from '../evals/rag/judgements-from-expected-sources';
import { parseJudgements } from '../evals/rag/judgements';
import { getTestById, getTestItemsByTestId } from '~/lib/tests/repository';

type Options = {
  testId: string;
  outFile: string | null;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Options {
  const outIndex = argv.indexOf('--out');
  const outFile = outIndex >= 0 ? argv[outIndex + 1] ?? null : null;
  const dryRun = argv.includes('--dry-run');
  const consumed = new Set<string>(outFile ? [outFile] : []);
  const testId = argv.find((arg) => !arg.startsWith('--') && !consumed.has(arg));

  if (!testId || (!outFile && !dryRun)) {
    throw new Error(
      'Usage: export-rag-judgements.ts <testId> [--out <file.json>] [--dry-run] — one of --out / --dry-run is required.',
    );
  }

  return { testId, outFile, dryRun };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [test, items] = await Promise.all([
    getTestById(options.testId),
    getTestItemsByTestId(options.testId),
  ]);

  const exported = buildJudgementsFromExpectedSources(items);
  const validation = parseJudgements(exported.judgements, 'test_items.expected_sources');
  if (!validation.ok) {
    const issues = validation.issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join('; ');
    throw new Error(`Generated judgements failed Phase 3 validation: ${issues}`);
  }

  const sourceCount = exported.judgements.reduce(
    (total, judgement) => total + judgement.relevantDocuments.length,
    0,
  );
  console.log(
    `Test ${test.id.slice(0, 8)} (${test.name}): ${items.length} items; ` +
      `${exported.judgements.length} document-labelled; ${exported.omitted.length} unlabelled; ` +
      `${sourceCount} document mappings.`,
  );

  if (exported.omitted.length > 0) {
    console.log(
      `Omitted rows with no expected sources: ${exported.omitted
        .map((item) => item.rowIndex)
        .join(', ')}. They remain unlabelled, never negative examples.`,
    );
  }

  if (options.dryRun || !options.outFile) return;

  const outputPath = path.resolve(options.outFile);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        schema: 'rag-judgements/v1',
        source: {
          testId: test.id,
          testName: test.name,
          labelSource: 'test_items.expected_sources',
          relevance: 'binary',
          exportedAt: new Date().toISOString(),
        },
        judgements: exported.judgements,
        omitted: exported.omitted,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`Wrote ${exported.judgements.length} judgements → ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
