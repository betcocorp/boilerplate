import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-647/648/650/680 — semantic router unit tests. No real OpenAI call for the example corpus and
 * no Redis (B0-680 deleted `semantic-router-cache.ts` entirely): the pre-computed embeddings file
 * is mocked via `semantic-router-embeddings-source.ts` — the thin indirection module
 * `semantic-router.ts` reads it through — so these tests exercise the loader/validator logic
 * against a synthetic corpus without depending on real OpenAI-computed vectors being checked in.
 * The OpenAI client mock and the `settings` reader mock remain: a LIVE user message is still
 * embedded via OpenAI on every call (same style as `intent-classifier.test.ts`, including the
 * arrow-wrapped mock bodies so the hoisted `vi.mock` factories can reference these consts).
 */
const embeddingsCreateMock = vi.fn();
vi.mock('~/lib/openai/client', () => ({
  getOpenAIClient: () => ({
    embeddings: { create: (...args: unknown[]) => embeddingsCreateMock(...args) },
  }),
}));

// `vi.hoisted` because the factory below needs a stable object to close over, but its CONTENT
// (`buildValidEmbeddingsFile()`) depends on `SME_AGENT_IDS` / `SEMANTIC_ROUTER_EXAMPLES`, which are
// only available once the real imports further down this file have run. The ref exists from the
// first possible moment; `.current` is populated once those imports are in scope (see below) and
// reset per-test in `beforeEach`.
const embeddingsFileRef = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('~/lib/orchestrator/semantic-router-embeddings-source', () => ({
  get semanticRouterEmbeddingsFile() {
    return embeddingsFileRef.current;
  },
}));

// Echoes each call's own `fallback`, so the documented defaults (0.50 / 0.10 /
// text-embedding-3-large) are what the tests see unless a case overrides them.
vi.mock('~/lib/settings/settings-service', () => ({
  getNumberSetting: vi.fn((_key: string, fallback: number) => Promise.resolve(fallback)),
  getStringSetting: vi.fn((_key: string, fallback: string) => Promise.resolve(fallback)),
}));

import { SME_AGENT_IDS, type SmeAgentId } from '~/lib/agents/agent-registry';
import {
  DEFAULT_SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD,
  DEFAULT_SEMANTIC_ROUTER_EMBEDDING_MODEL,
  DEFAULT_SEMANTIC_ROUTER_MARGIN_THRESHOLD,
  SEMANTIC_ROUTER_EMBEDDING_DIMENSIONS,
  SEMANTIC_ROUTER_SETTING_KEYS,
  getSemanticRouterConfidenceThreshold,
  getSemanticRouterEmbeddingModel,
  getSemanticRouterMarginThreshold,
} from '~/lib/orchestrator/semantic-router-config';
import type { SemanticRouterEmbeddingsFile } from '~/lib/orchestrator/semantic-router-embeddings-source';
import {
  SEMANTIC_ROUTER_EXAMPLES,
  SEMANTIC_ROUTER_EXAMPLE_COUNT,
  SEMANTIC_ROUTER_EXAMPLES_VERSION,
} from '~/lib/orchestrator/semantic-router-examples';
import {
  buildSemanticRouteDecision,
  classifyUserIntentSemantic,
  cosineSimilarity,
  getSemanticRouterCacheStats,
  initSemanticRouter,
  resetSemanticRouterForTest,
  scoreRoutes,
  vectorNorm,
  type RouteVectors,
} from '~/lib/orchestrator/semantic-router';
import { getNumberSetting, getStringSetting } from '~/lib/settings/settings-service';

const DIMS = SEMANTIC_ROUTER_EMBEDDING_DIMENSIONS;

/** Unit vector along one axis — an easy way to make "topics" that are exactly orthogonal. */
function basis(index: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[index] = 1;
  return v;
}

/** Unit vector whose cosine against `basis(index)` is exactly `similarity`. */
function vectorWithSimilarity(index: number, similarity: number, noiseAxis = 3000): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[index] = similarity;
  v[noiseAxis] = Math.sqrt(Math.max(0, 1 - similarity * similarity));
  return v;
}

/** Unit vector equidistant from two axes (cosine ≈ 0.7071 to each) — a genuine tie. */
function tiedVector(indexA: number, indexB: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  const share = Math.SQRT1_2;
  v[indexA] = share;
  v[indexB] = share;
  return v;
}

const routeAxis = (route: SmeAgentId): number => SME_AGENT_IDS.indexOf(route);

/** Every authored example maps to its own route's axis, so the corpus is perfectly separable. */
const exampleAxisByText = new Map<string, number>();
for (const route of SME_AGENT_IDS) {
  for (const example of SEMANTIC_ROUTER_EXAMPLES[route]) {
    exampleAxisByText.set(example, routeAxis(route));
  }
}

/**
 * B0-680 — a valid `semantic-router-embeddings.json`-shaped fixture standing in for the mocked
 * `semanticRouterEmbeddingsFile` import. Every example's vector sits on its own route's axis,
 * matching `exampleAxisByText`/`vectorForInput` above, so a live message vectored onto that same
 * axis is a clean match against the whole corpus, not just a single example.
 */
function buildValidEmbeddingsFile(): SemanticRouterEmbeddingsFile {
  const routes: SemanticRouterEmbeddingsFile['routes'] = {};
  for (const route of SME_AGENT_IDS) {
    const examples = SEMANTIC_ROUTER_EXAMPLES[route];
    routes[route] = {
      examples: [...examples],
      vectors: examples.map(() => basis(routeAxis(route))),
    };
  }
  return {
    format: 1,
    examplesVersion: SEMANTIC_ROUTER_EXAMPLES_VERSION,
    embeddingModel: DEFAULT_SEMANTIC_ROUTER_EMBEDDING_MODEL,
    dimensions: DIMS,
    generatedAt: 'test-fixture',
    routes,
  };
}

/** Typed convenience setter for the mocked `semanticRouterEmbeddingsFile` — see `embeddingsFileRef` above. */
function setMockEmbeddingsFile(file: SemanticRouterEmbeddingsFile): void {
  embeddingsFileRef.current = file;
}

/** Test-controlled vectors for live messages, keyed by the exact message text. */
const messageVectors = new Map<string, number[]>();

function vectorForInput(input: string): number[] {
  const override = messageVectors.get(input);
  if (override) return override;
  const axis = exampleAxisByText.get(input);
  // Unknown text lands on an axis no route occupies, i.e. "matches nothing".
  return basis(axis ?? 2500);
}

function embedResponse(inputs: string[]) {
  return { data: inputs.map((text) => ({ embedding: vectorForInput(text) })) };
}

beforeEach(() => {
  resetSemanticRouterForTest();
  messageVectors.clear();
  embeddingsCreateMock.mockReset();
  embeddingsCreateMock.mockImplementation((body: { input: string[] }) =>
    Promise.resolve(embedResponse(body.input)),
  );
  setMockEmbeddingsFile(buildValidEmbeddingsFile());
  vi.mocked(getNumberSetting).mockImplementation((_key, fallback) => Promise.resolve(fallback));
  vi.mocked(getStringSetting).mockImplementation((_key, fallback) => Promise.resolve(fallback));
});

afterEach(() => {
  resetSemanticRouterForTest();
});

// ---------------------------------------------------------------------------------------------

describe('B0-647 example corpus', () => {
  it('defines 8-10 discriminative examples for every SME route', () => {
    for (const route of SME_AGENT_IDS) {
      const examples = SEMANTIC_ROUTER_EXAMPLES[route];
      expect(examples.length, `${route} example count`).toBeGreaterThanOrEqual(8);
      expect(examples.length, `${route} example count`).toBeLessThanOrEqual(10);
    }
  });

  it('covers exactly the SME registry — no orphaned or missing route', () => {
    expect(Object.keys(SEMANTIC_ROUTER_EXAMPLES).sort()).toEqual([...SME_AGENT_IDS].sort());
  });

  it('defines ~82 examples in total, with no duplicate utterance across the whole corpus', () => {
    // B0-746 — 4 routes (product, bathroom, dilution, cross_reference) x 10 + 5 routes
    // (recommendations, floor_wood_sport, floor_concrete, floor_stg, floor_vct) x 8 = 80.
    // B0-1034 — +2 product-selection utterances on `floor_vct` (now 10) = 82.
    expect(SEMANTIC_ROUTER_EXAMPLE_COUNT).toBe(82);
    const all = SME_AGENT_IDS.flatMap((route) => [...SEMANTIC_ROUTER_EXAMPLES[route]]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('has a version string (the cache key) and no blank utterances', () => {
    expect(SEMANTIC_ROUTER_EXAMPLES_VERSION).toMatch(/^v\d+$/);
    for (const route of SME_AGENT_IDS) {
      for (const example of SEMANTIC_ROUTER_EXAMPLES[route]) {
        expect(example.trim().length).toBeGreaterThan(10);
      }
    }
  });

  it('never bakes a regulated value into an utterance (dilution ratios, contact times, ppm, EPA numbers, log reduction)', () => {
    // Regulated data must be transcribed from a label, never invented — the examples ASK for these
    // values instead of asserting them.
    const forbidden = [
      /\b\d+\s*:\s*\d+\b/, // bare ratios like 1:64
      /\b\d+(\.\d+)?\s*(oz|ounces?)\s*(per|\/)\s*(gal|gallon)/i,
      /\b\d+(\.\d+)?\s*(ml|millilitres?|milliliters?)\s*(per|\/)\s*(l|litre|liter)/i,
      /\b\d+(\.\d+)?\s*ppm\b/i,
      /\b\d+(\.\d+)?\s*%/,
      /\b\d+\s*(-|\s)?log\b/i,
      /\bEPA\s*(reg\.?|registration)?\s*(no\.?|number|#)?\s*\d/i,
      /\b\d+\s*(second|minute)s?\s+(contact|dwell)\b/i,
    ];
    for (const route of SME_AGENT_IDS) {
      for (const example of SEMANTIC_ROUTER_EXAMPLES[route]) {
        for (const pattern of forbidden) {
          expect(pattern.test(example), `${route}: "${example}" matched ${pattern}`).toBe(false);
        }
      }
    }
  });
});

describe('B0-648 similarity math', () => {
  it('scores an identical vector at 1 and an orthogonal vector at 0', () => {
    expect(cosineSimilarity(basis(1), basis(1))).toBeCloseTo(1, 10);
    expect(cosineSimilarity(basis(1), basis(2))).toBeCloseTo(0, 10);
  });

  it('returns the requested similarity for a deliberately blended vector', () => {
    expect(cosineSimilarity(vectorWithSimilarity(0, 0.42), basis(0))).toBeCloseTo(0.42, 6);
  });

  it('degrades to 0 rather than NaN for zero vectors, length mismatches, and empty input', () => {
    const zero = new Array<number>(DIMS).fill(0);
    expect(cosineSimilarity(zero, basis(0))).toBe(0);
    expect(cosineSimilarity(basis(0), zero)).toBe(0);
    expect(cosineSimilarity([1, 0, 0], basis(0))).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('treats a non-finite vector as no match instead of poisoning the score', () => {
    const broken = basis(0);
    broken[5] = Number.NaN;
    expect(vectorNorm(broken)).toBe(0);
    expect(cosineSimilarity(broken, basis(0))).toBe(0);
  });

  it('aggregates each route by MAX example similarity, not the mean', () => {
    // "floor_vct" has one near-perfect example and nine unrelated ones; "product" has ten
    // moderately-similar examples whose MEAN beats floor_vct's mean but whose MAX does not.
    const message = basis(0);
    const routes: RouteVectors[] = [
      makeRouteVectors('floor_vct', [basis(0), ...Array.from({ length: 9 }, () => basis(1000))]),
      makeRouteVectors(
        'product',
        Array.from({ length: 10 }, () => vectorWithSimilarity(0, 0.6)),
      ),
    ];

    const scores = scoreRoutes(message, vectorNorm(message), routes);

    expect(scores[0]?.route).toBe('floor_vct');
    expect(scores[0]?.similarity).toBeCloseTo(1, 6);
    expect(scores[1]?.similarity).toBeCloseTo(0.6, 6);
  });

  it('returns every route sorted descending, clamping a negative cosine to 0', () => {
    const message = basis(0);
    const opposite = basis(0).map((v) => -v);
    const routes: RouteVectors[] = [
      makeRouteVectors('product', [opposite]),
      makeRouteVectors('floor_vct', [basis(0)]),
    ];

    const scores = scoreRoutes(message, vectorNorm(message), routes);

    expect(scores.map((s) => s.route)).toEqual(['floor_vct', 'product']);
    expect(scores[1]?.similarity).toBe(0);
  });
});

function makeRouteVectors(route: SmeAgentId, vectors: number[][]): RouteVectors {
  return {
    route,
    examples: vectors.map((_, i) => `${route}-example-${i}`),
    vectors,
    norms: vectors.map(vectorNorm),
  };
}

describe('B0-650 threshold gating (pure decision builder)', () => {
  const thresholds = { confidence: 0.5, margin: 0.1 };
  const base = {
    thresholds,
    latencyMs: 1,
    embeddingMs: 0,
    scoringMs: 0.4,
    embeddingModel: DEFAULT_SEMANTIC_ROUTER_EMBEDDING_MODEL,
    examplesVersion: SEMANTIC_ROUTER_EXAMPLES_VERSION,
    error: null,
  };

  it('routes only when BOTH gates pass', () => {
    const decision = buildSemanticRouteDecision({
      ...base,
      scores: [
        { route: 'floor_vct', similarity: 0.72 },
        { route: 'product', similarity: 0.41 },
      ],
    });

    expect(decision.route).toBe('floor_vct');
    expect(decision.path).toBe('semantic');
    expect(decision.confidence).toBeCloseTo(0.72, 6);
    expect(decision.similarity).toBe(decision.confidence);
    expect(decision.margin).toBeCloseTo(0.31, 6);
    expect(decision.thresholdsPassed).toEqual({ confidence: true, margin: true });
  });

  it('falls back when the confidence gate fails even though the margin is wide', () => {
    const decision = buildSemanticRouteDecision({
      ...base,
      scores: [
        { route: 'floor_vct', similarity: 0.4 },
        { route: 'product', similarity: 0.05 },
      ],
    });

    expect(decision.route).toBe('ambiguous');
    expect(decision.path).toBe('fallback');
    expect(decision.thresholdsPassed).toEqual({ confidence: false, margin: true });
  });

  it('falls back when the margin gate fails even though confidence is high', () => {
    const decision = buildSemanticRouteDecision({
      ...base,
      scores: [
        { route: 'floor_vct', similarity: 0.81 },
        { route: 'bathroom', similarity: 0.78 },
      ],
    });

    expect(decision.route).toBe('ambiguous');
    expect(decision.path).toBe('fallback');
    expect(decision.thresholdsPassed).toEqual({ confidence: true, margin: false });
  });

  it('passes a gate exactly AT the threshold (>=, not >)', () => {
    // Binary-exact values on purpose: 0.5 - 0.4 is 0.09999999999999998 in IEEE754, so a "0.5 vs
    // 0.4 against a 0.1 margin" case would be testing float representation, not the comparison.
    const decision = buildSemanticRouteDecision({
      ...base,
      thresholds: { confidence: 0.5, margin: 0.25 },
      scores: [
        { route: 'floor_vct', similarity: 0.5 },
        { route: 'product', similarity: 0.25 },
      ],
    });

    expect(decision.path).toBe('semantic');
    expect(decision.thresholdsPassed).toEqual({ confidence: true, margin: true });
  });

  it('treats the runner-up as 0 when only one route scored', () => {
    const decision = buildSemanticRouteDecision({
      ...base,
      scores: [{ route: 'floor_vct', similarity: 0.6 }],
    });

    expect(decision.margin).toBeCloseTo(0.6, 6);
    expect(decision.path).toBe('semantic');
  });

  it('is always a fallback with no scores, or when an error is present', () => {
    const empty = buildSemanticRouteDecision({ ...base, scores: [] });
    expect(empty.route).toBe('ambiguous');
    expect(empty.path).toBe('fallback');
    expect(empty.confidence).toBe(0);
    expect(empty.margin).toBe(0);

    const errored = buildSemanticRouteDecision({
      ...base,
      error: 'openai down',
      scores: [
        { route: 'floor_vct', similarity: 0.99 },
        { route: 'product', similarity: 0.1 },
      ],
    });
    expect(errored.route).toBe('ambiguous');
    expect(errored.path).toBe('fallback');
  });
});

describe('B0-650 threshold configuration', () => {
  it('exposes the three seeded setting keys', () => {
    expect([...SEMANTIC_ROUTER_SETTING_KEYS]).toEqual([
      'SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD',
      'SEMANTIC_ROUTER_MARGIN_THRESHOLD',
      'SEMANTIC_ROUTER_EMBEDDING_MODEL',
    ]);
  });

  it('defaults to 0.50 / 0.10 / text-embedding-3-large when the rows are missing', async () => {
    expect(await getSemanticRouterConfidenceThreshold()).toBe(
      DEFAULT_SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD,
    );
    expect(await getSemanticRouterMarginThreshold()).toBe(
      DEFAULT_SEMANTIC_ROUTER_MARGIN_THRESHOLD,
    );
    expect(await getSemanticRouterEmbeddingModel()).toBe('text-embedding-3-large');
  });

  it('honors stored values and clamps nonsensical ones into [0,1]', async () => {
    vi.mocked(getNumberSetting).mockResolvedValueOnce(0.35);
    expect(await getSemanticRouterConfidenceThreshold()).toBeCloseTo(0.35, 6);

    vi.mocked(getNumberSetting).mockResolvedValueOnce(9);
    expect(await getSemanticRouterConfidenceThreshold()).toBe(1);

    vi.mocked(getNumberSetting).mockResolvedValueOnce(-3);
    expect(await getSemanticRouterMarginThreshold()).toBe(0);
  });

  it('refuses an unsupported embedding model rather than sending a 1536-dim model to OpenAI', async () => {
    vi.mocked(getStringSetting).mockResolvedValueOnce('text-embedding-3-small');
    expect(await getSemanticRouterEmbeddingModel()).toBe('text-embedding-3-large');
  });
});

describe('B0-680 initSemanticRouter (pre-computed embeddings file)', () => {
  it('loads every example embedding from the pre-computed file without calling OpenAI', async () => {
    const result = await initSemanticRouter();

    expect(result.routeCount).toBe(SME_AGENT_IDS.length);
    expect(result.exampleCount).toBe(SEMANTIC_ROUTER_EXAMPLE_COUNT);
    expect(result.source).toBe('static');
    expect(result.errors).toEqual([]);
    expect(result.examplesVersion).toBe(SEMANTIC_ROUTER_EXAMPLES_VERSION);
    expect(result.embeddingModel).toBe('text-embedding-3-large');
    // No live-message call happened either — init touches OpenAI zero times.
    expect(embeddingsCreateMock).not.toHaveBeenCalled();
  });

  it('is idempotent: a second call re-uses the in-memory corpus', async () => {
    await initSemanticRouter();

    const second = await initSemanticRouter();

    expect(second.source).toBe('memory');
    expect(second.exampleCount).toBe(SEMANTIC_ROUTER_EXAMPLE_COUNT);
    expect(embeddingsCreateMock).not.toHaveBeenCalled();
  });

  it('dedupes concurrent initialization into a single pass', async () => {
    const [a, b, c] = await Promise.all([
      initSemanticRouter(),
      initSemanticRouter(),
      initSemanticRouter(),
    ]);

    expect(a.exampleCount).toBe(SEMANTIC_ROUTER_EXAMPLE_COUNT);
    expect(b.exampleCount).toBe(SEMANTIC_ROUTER_EXAMPLE_COUNT);
    expect(c.exampleCount).toBe(SEMANTIC_ROUTER_EXAMPLE_COUNT);
    expect(embeddingsCreateMock).not.toHaveBeenCalled();
  });

  it('still initializes the routes that validate when one route is missing from the file', async () => {
    const file = buildValidEmbeddingsFile();
    delete file.routes.floor_vct;
    setMockEmbeddingsFile(file);

    const result = await initSemanticRouter();

    expect(result.routeCount).toBe(SME_AGENT_IDS.length - 1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('floor_vct');
    expect(result.errors[0]).toContain('missing from the embeddings file');
  });

  it('skips a route whose example text has drifted from semantic-router-examples.ts', async () => {
    const file = buildValidEmbeddingsFile();
    file.routes.bathroom!.examples[0] = 'a stale example nobody edited the version for';
    setMockEmbeddingsFile(file);

    const result = await initSemanticRouter();

    expect(result.routeCount).toBe(SME_AGENT_IDS.length - 1);
    expect(result.errors[0]).toContain('bathroom');
    expect(result.errors[0]).toContain('regenerate');
  });

  it('skips a route with a non-finite value in a stored vector', async () => {
    const file = buildValidEmbeddingsFile();
    file.routes.dilution!.vectors[0]![0] = Number.NaN;
    setMockEmbeddingsFile(file);

    const result = await initSemanticRouter();

    expect(result.routeCount).toBe(SME_AGENT_IDS.length - 1);
    expect(result.errors[0]).toContain('dilution');
  });

  it('rejects the whole file when the examples version is stale', async () => {
    setMockEmbeddingsFile({ ...buildValidEmbeddingsFile(), examplesVersion: 'v0-stale' });

    const result = await initSemanticRouter();

    expect(result.routeCount).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('v0-stale');
    expect(result.errors[0]).toContain(SEMANTIC_ROUTER_EXAMPLES_VERSION);
  });

  it('rejects the whole file when the embedding model does not match the current setting', async () => {
    setMockEmbeddingsFile({ ...buildValidEmbeddingsFile(), embeddingModel: 'text-embedding-3-small' });

    const result = await initSemanticRouter();

    expect(result.routeCount).toBe(0);
    expect(result.errors[0]).toContain('text-embedding-3-small');
  });

  it('rejects the whole file when its dimensions do not match the router constant', async () => {
    setMockEmbeddingsFile({ ...buildValidEmbeddingsFile(), dimensions: 1536 });

    const result = await initSemanticRouter();

    expect(result.routeCount).toBe(0);
    expect(result.errors[0]).toContain('1536');
  });

  it('rejects the whole file on an unrecognized envelope format', async () => {
    setMockEmbeddingsFile({ ...buildValidEmbeddingsFile(), format: 2 });

    const result = await initSemanticRouter();

    expect(result.routeCount).toBe(0);
    expect(result.errors[0]).toContain('format');
  });

  it('never throws on total failure (bad file), and clears the memo so the next call can retry', async () => {
    setMockEmbeddingsFile({ ...buildValidEmbeddingsFile(), format: 2 });

    const failed = await initSemanticRouter();
    expect(failed.routeCount).toBe(0);
    expect(failed.errors).toHaveLength(1);

    setMockEmbeddingsFile(buildValidEmbeddingsFile());

    const retried = await initSemanticRouter();
    expect(retried.routeCount).toBe(SME_AGENT_IDS.length);
    expect(retried.errors).toEqual([]);
  });
});

describe('B0-648 classifyUserIntentSemantic', () => {
  it('routes a clearly-matching message to its route on the semantic path', async () => {
    messageVectors.set('strip and recoat this VCT floor', basis(routeAxis('floor_vct')));

    const decision = await classifyUserIntentSemantic('strip and recoat this VCT floor');

    expect(decision.route).toBe('floor_vct');
    expect(decision.path).toBe('semantic');
    expect(decision.confidence).toBeCloseTo(1, 6);
    expect(decision.similarity).toBe(decision.confidence);
    expect(decision.margin).toBeCloseTo(1, 6);
    expect(decision.thresholdsPassed).toEqual({ confidence: true, margin: true });
    expect(decision.scores).toHaveLength(SME_AGENT_IDS.length);
    expect(decision.scores[0]).toEqual({ route: 'floor_vct', similarity: decision.confidence });
    expect(decision.error).toBeNull();
    expect(decision.thresholds).toEqual({ confidence: 0.5, margin: 0.1 });
    expect(decision.embeddingModel).toBe('text-embedding-3-large');
    expect(decision.examplesVersion).toBe(SEMANTIC_ROUTER_EXAMPLES_VERSION);
  });

  it('falls back when the top score is below the confidence threshold', async () => {
    messageVectors.set('vague question', vectorWithSimilarity(routeAxis('floor_vct'), 0.4));

    const decision = await classifyUserIntentSemantic('vague question');

    expect(decision.path).toBe('fallback');
    expect(decision.route).toBe('ambiguous');
    expect(decision.confidence).toBeCloseTo(0.4, 6);
    expect(decision.thresholdsPassed).toEqual({ confidence: false, margin: true });
    // The scores are still reported, so the fallback is diagnosable.
    expect(decision.scores[0]?.route).toBe('floor_vct');
    expect(decision.error).toBeNull();
  });

  it('falls back when two routes tie inside the margin threshold', async () => {
    messageVectors.set(
      'disinfect the locker room floor',
      tiedVector(routeAxis('floor_vct'), routeAxis('bathroom')),
    );

    const decision = await classifyUserIntentSemantic('disinfect the locker room floor');

    expect(decision.path).toBe('fallback');
    expect(decision.confidence).toBeCloseTo(Math.SQRT1_2, 6);
    expect(decision.margin).toBeCloseTo(0, 6);
    expect(decision.thresholdsPassed).toEqual({ confidence: true, margin: false });
  });

  it('respects a re-tuned confidence threshold from the settings table', async () => {
    messageVectors.set('borderline', vectorWithSimilarity(routeAxis('product'), 0.6));

    const permissive = await classifyUserIntentSemantic('borderline');
    expect(permissive.path).toBe('semantic');

    resetSemanticRouterForTest();
    vi.mocked(getNumberSetting).mockImplementation((key, fallback) =>
      Promise.resolve(key === 'SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD' ? 0.9 : fallback),
    );

    const strict = await classifyUserIntentSemantic('borderline');
    expect(strict.thresholds.confidence).toBe(0.9);
    expect(strict.path).toBe('fallback');
  });

  it('degrades (never throws) on a blank message, without calling OpenAI', async () => {
    const decision = await classifyUserIntentSemantic('   ');

    expect(decision.path).toBe('fallback');
    expect(decision.route).toBe('ambiguous');
    expect(decision.error).toBe('empty_message');
    expect(embeddingsCreateMock).not.toHaveBeenCalled();
  });

  it('degrades (never throws) when the message embedding call fails, and does not cache the failure', async () => {
    await initSemanticRouter();
    embeddingsCreateMock.mockRejectedValueOnce(new Error('embedding api down'));

    const failed = await classifyUserIntentSemantic('a floor question');
    expect(failed.path).toBe('fallback');
    expect(failed.route).toBe('ambiguous');
    expect(failed.error).toContain('embedding api down');

    // Next identical call retries rather than serving the cached failure for the TTL.
    messageVectors.set('a floor question', basis(routeAxis('floor_vct')));
    const retried = await classifyUserIntentSemantic('a floor question');
    expect(retried.path).toBe('semantic');
    expect(retried.route).toBe('floor_vct');
  });

  it('degrades when the corpus could not be initialized at all (bad embeddings file)', async () => {
    setMockEmbeddingsFile({ ...buildValidEmbeddingsFile(), format: 2 });

    const decision = await classifyUserIntentSemantic('a floor question');

    expect(decision.path).toBe('fallback');
    expect(decision.route).toBe('ambiguous');
    expect(decision.error).toContain('format');
    expect(decision.scores).toEqual([]);
    // The corpus never loaded, so the live message was never even sent to embed.
    expect(embeddingsCreateMock).not.toHaveBeenCalled();
  });

  it('caches the message embedding in-process: a repeat call makes no API call and reports embeddingMs 0', async () => {
    messageVectors.set('strip and recoat this VCT floor', basis(routeAxis('floor_vct')));

    const cold = await classifyUserIntentSemantic('strip and recoat this VCT floor');
    const callsAfterCold = embeddingsCreateMock.mock.calls.length;
    const warm = await classifyUserIntentSemantic('strip and recoat this VCT floor');

    expect(embeddingsCreateMock).toHaveBeenCalledTimes(callsAfterCold);
    expect(warm.route).toBe(cold.route);
    expect(warm.embeddingMs).toBe(0);
    expect(getSemanticRouterCacheStats()).toMatchObject({ hits: 1, misses: 1 });
    expect(getSemanticRouterCacheStats().size).toBeGreaterThan(0);
  });

  it('resetSemanticRouterForTest clears the corpus and the message cache', async () => {
    messageVectors.set('strip and recoat this VCT floor', basis(routeAxis('floor_vct')));
    await classifyUserIntentSemantic('strip and recoat this VCT floor');
    expect(getSemanticRouterCacheStats().size).toBe(1);

    resetSemanticRouterForTest();

    expect(getSemanticRouterCacheStats()).toEqual({ hits: 0, misses: 0, size: 0 });
  });
});

/**
 * B0-648 latency budget, measured honestly.
 *
 * The ticket asks for "≤10ms p95 including the embedding call". A live OpenAI embedding round-trip
 * is tens to hundreds of ms, so that number cannot describe a cold call — what it can and does
 * describe is the cosine pass (`scoringMs`) and the warm, embedding-cached call. Those are what is
 * asserted here; a cold call's real `embeddingMs` is reported by the decision itself rather than
 * being faked into a passing number.
 */
describe('B0-648 latency budget', () => {
  const percentile = (values: number[], p: number): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, index)]!;
  };

  it('keeps the cosine pass (50 examples x 3072 dims) under the 10ms budget at p95', async () => {
    const scoringSamples: number[] = [];

    for (let i = 0; i < 60; i += 1) {
      const message = `distinct latency probe ${i}`;
      messageVectors.set(message, vectorWithSimilarity(routeAxis('floor_vct'), 0.7));
      const decision = await classifyUserIntentSemantic(message);
      scoringSamples.push(decision.scoringMs);
    }

    expect(percentile(scoringSamples, 95)).toBeLessThanOrEqual(10);
    expect(percentile(scoringSamples, 100)).toBeLessThanOrEqual(25); // generous tail for a cold JIT
  });

  it('keeps the whole warm (embedding-cached) call under the 10ms budget at p95', async () => {
    const message = 'strip and recoat this VCT floor';
    messageVectors.set(message, basis(routeAxis('floor_vct')));
    await classifyUserIntentSemantic(message); // prime the cache

    const warmSamples: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      const decision = await classifyUserIntentSemantic(message);
      expect(decision.embeddingMs).toBe(0);
      warmSamples.push(decision.latencyMs);
    }

    expect(percentile(warmSamples, 95)).toBeLessThanOrEqual(10);
  });

  it('reports a cold call\'s embedding time separately from its scoring time', async () => {
    const message = 'a cold floor question';
    messageVectors.set(message, basis(routeAxis('floor_vct')));
    // 40ms stand-in for the real round-trip, so the assertion is about ATTRIBUTION, not speed.
    embeddingsCreateMock.mockImplementation(
      (body: { input: string[] }) =>
        new Promise((resolve) => {
          setTimeout(() => resolve(embedResponse(body.input)), 40);
        }),
    );

    const decision = await classifyUserIntentSemantic(message);

    expect(decision.embeddingMs).toBeGreaterThanOrEqual(35);
    expect(decision.scoringMs).toBeLessThanOrEqual(10);
    expect(decision.latencyMs).toBeGreaterThanOrEqual(decision.embeddingMs);
  });
});
