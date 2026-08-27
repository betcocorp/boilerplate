#!/usr/bin/env -S npx tsx
/**
 * B0-680 — one-off generator for `src/lib/orchestrator/semantic-router-embeddings.json`.
 *
 * The semantic router's example corpus (`SEMANTIC_ROUTER_EXAMPLES`) is stable and versioned in
 * git, so its embeddings no longer need to be computed on first instance boot (B0-654's Redis
 * cache) — they are computed ONCE, here, and checked in as static JSON. `semantic-router.ts`
 * loads that file directly at init; it makes NO OpenAI call and NO Redis call for the example
 * corpus (a live user message is still embedded per-request — that part is unavoidable and
 * unchanged).
 *
 * This script is NOT part of the app build or CI — it's a manual regeneration tool, run only
 * when `SEMANTIC_ROUTER_EXAMPLES` changes (which also requires bumping
 * `SEMANTIC_ROUTER_EXAMPLES_VERSION` — see the authoring rules in `semantic-router-examples.ts`).
 *
 * Usage (repo root, requires OPENAI_API_KEY in the environment or `.env.local`):
 *   npx tsx --env-file=.env.local scripts/generate-semantic-router-embeddings.ts
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SME_AGENT_IDS, type SmeAgentId } from '~/lib/agents/agent-registry';
import { getOpenAIClient } from '~/lib/openai/client';
import {
  DEFAULT_SEMANTIC_ROUTER_EMBEDDING_MODEL,
  SEMANTIC_ROUTER_EMBEDDING_DIMENSIONS,
} from '~/lib/orchestrator/semantic-router-config';
import {
  SEMANTIC_ROUTER_EXAMPLES,
  SEMANTIC_ROUTER_EXAMPLES_VERSION,
} from '~/lib/orchestrator/semantic-router-examples';

// Mirrors `SemanticRouterEmbeddingsFile` in `semantic-router.ts` — kept as a local literal here
// (not imported) so this script has no compile-time dependency on the runtime module.
type OutputFile = {
  format: 1;
  examplesVersion: string;
  embeddingModel: string;
  dimensions: number;
  generatedAt: string;
  routes: Record<SmeAgentId, { examples: string[]; vectors: number[][] }>;
};

async function embedBatch(inputs: readonly string[], model: string): Promise<number[][]> {
  const client = getOpenAIClient();
  const response = await client.embeddings.create({ model, input: [...inputs] });

  if (response.data.length !== inputs.length) {
    throw new Error(
      `Expected ${inputs.length} embeddings from OpenAI but received ${response.data.length}.`,
    );
  }

  return response.data.map((item, index) => {
    const vector = item.embedding;
    if (!Array.isArray(vector) || vector.length !== SEMANTIC_ROUTER_EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding ${index} had ${vector?.length ?? 0} dimensions; expected ${SEMANTIC_ROUTER_EMBEDDING_DIMENSIONS}.`,
      );
    }
    return vector;
  });
}

async function main(): Promise<void> {
  const model = DEFAULT_SEMANTIC_ROUTER_EMBEDDING_MODEL;
  console.log(
    `Embedding ${SME_AGENT_IDS.length} routes (examples version ${SEMANTIC_ROUTER_EXAMPLES_VERSION}) with model ${model}...`,
  );

  const routes = {} as OutputFile['routes'];

  for (const route of SME_AGENT_IDS) {
    const examples = SEMANTIC_ROUTER_EXAMPLES[route];
    if (!examples || examples.length === 0) {
      throw new Error(`Route ${route} has no examples — refusing to write an incomplete file.`);
    }
    process.stdout.write(`  ${route} (${examples.length} examples)... `);
    const vectors = await embedBatch(examples, model);
    routes[route] = { examples: [...examples], vectors };
    console.log('done');
  }

  const output: OutputFile = {
    format: 1,
    examplesVersion: SEMANTIC_ROUTER_EXAMPLES_VERSION,
    embeddingModel: model,
    dimensions: SEMANTIC_ROUTER_EMBEDDING_DIMENSIONS,
    generatedAt: new Date().toISOString(),
    routes,
  };

  const outPath = path.resolve(
    import.meta.dirname,
    '../src/lib/orchestrator/semantic-router-embeddings.json',
  );
  await writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
