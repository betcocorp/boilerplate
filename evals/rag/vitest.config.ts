import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the Phase 3 RAG eval suite ONLY.
 *
 * Kept separate from the root `vitest.config.ts` deliberately:
 *
 * - The root suite (`src/**\/*.test.ts`) is the app's unit suite and runs on every change. The eval
 *   suite is a measurement harness — it should be runnable on its own, and it must never lengthen
 *   the app suite by accident.
 * - `root` is pinned to this file's directory, so `include` cannot reach outside `evals/rag/`. That
 *   is the mechanical guarantee that this config does not pull in the root suite — vitest's `root`
 *   otherwise defaults to the working directory, which for `pnpm exec` is the repo root, and the
 *   suite would silently run all of `src/`. The reverse holds too: the root config includes `src/**`
 *   only and never sees `evals/`.
 *
 * The `~` alias mirrors the root config exactly (`<repo>/src`), because the runner and the adapter
 * import Phase 0's acquisition layer from `~/lib/tests/...`. The metric core itself stays free of
 * `~` imports — see `types.ts` for why.
 *
 *   pnpm exec vitest run --config evals/rag/vitest.config.ts
 */
export default defineConfig({
  // Without this the cache lands in `evals/rag/node_modules/`, which nothing ignores — `evals/` is
  // untracked wholesale today, so the cache would ride along the first time it is added.
  cacheDir: path.resolve(__dirname, '../../node_modules/.vite'),
  test: {
    root: __dirname,
    environment: 'node',
    include: ['**/*.test.ts'],
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, '../../src'),
    },
  },
});
