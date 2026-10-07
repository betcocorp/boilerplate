import { unstable_cache } from 'next/cache';

import {
  getRagBoostConfig,
  getRagChunkingConfig,
  type RagBoostConfig,
  type RagChunkingConfig,
} from '~/lib/settings/settings-service';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

export type ChunkTokenStats = {
  totalChunks: number;
  avgTokens: number;
  minTokens: number;
  maxTokens: number;
  distribution: {
    under100: number;
    from100to299: number;
    from300to599: number;
    from600to999: number;
    over1000: number;
  };
};

export type EnrichmentDocument = {
  id: string;
  documentKey: string;
  title: string;
  documentKind: string;
  surfaceType: string;
  dwellTimeMinutes: string;
  dilutionRatio: string;
};

type RawDocumentRow = {
  id: string;
  document_key: string;
  title: string;
  document_kind: string;
  metadata: Record<string, unknown> | null;
};

const EMPTY_CHUNK_TOKEN_STATS: ChunkTokenStats = {
  totalChunks: 0,
  avgTokens: 0,
  minTokens: 0,
  maxTokens: 0,
  distribution: { under100: 0, from100to299: 0, from300to599: 0, from600to999: 0, over1000: 0 },
};

type ChunkCountClient = {
  select(
    cols: string,
    opts: { count: 'exact'; head: true },
  ): Promise<{ count: number | null; error: { message: string } | null }>;
};

/** Shape returned by the `rag.chunk_token_stats()` RPC. */
type RawChunkTokenStats = {
  total_chunks: number | null;
  avg_tokens: number | null;
  min_tokens: number | null;
  max_tokens: number | null;
  distribution: {
    under100: number | null;
    from100to299: number | null;
    from300to599: number | null;
    from600to999: number | null;
    over1000: number | null;
  } | null;
};

type ChunkStatsRpcClient = {
  rpc: (
    fn: 'chunk_token_stats',
  ) => Promise<{ data: RawChunkTokenStats | null; error: { message: string } | null }>;
};

/** Exact `rag.document_chunk` row count — a HEAD request, no rows transferred. */
async function countAllChunks(): Promise<number> {
  const supabase = getSupabaseServiceRoleClient();
  const { count, error } = await (
    supabase.schema('rag').from('document_chunk') as unknown as ChunkCountClient
  ).select('id', { count: 'exact', head: true });

  if (error) {
    throw new Error(`Failed to count corpus chunks: ${error.message}`);
  }
  return count ?? 0;
}

/**
 * B0-686 — corpus-wide token stats in one round trip.
 *
 * The previous implementation selected `token_count` and paged the whole table client-side.
 * PostgREST's `db-max-rows` is 1000 on this project, so the original `.limit(20000)` silently
 * returned the first 1,000 of ~29k chunks and the card was drawn from ~3.5% of the corpus in
 * physical row order. PostgREST aggregates are disabled here (PGRST123), so the aggregate lives
 * in SQL instead: `rag.chunk_token_stats()` is a single seq scan (~28ms) whose bucket boundaries
 * and `token_count is null -> 0` handling mirror what this function used to do in JS.
 */
async function loadChunkTokenStats(): Promise<ChunkTokenStats> {
  const supabase = getSupabaseServiceRoleClient();

  const { data, error } = await (
    supabase.schema('rag') as unknown as ChunkStatsRpcClient
  ).rpc('chunk_token_stats');

  if (error) {
    throw new Error(`Failed to fetch chunk token stats: ${error.message}`);
  }
  if (!data) {
    return EMPTY_CHUNK_TOKEN_STATS;
  }

  const buckets = data.distribution;

  return {
    totalChunks: data.total_chunks ?? 0,
    avgTokens: data.avg_tokens ?? 0,
    minTokens: data.min_tokens ?? 0,
    maxTokens: data.max_tokens ?? 0,
    distribution: {
      under100: buckets?.under100 ?? 0,
      from100to299: buckets?.from100to299 ?? 0,
      from300to599: buckets?.from300to599 ?? 0,
      from600to999: buckets?.from600to999 ?? 0,
      over1000: buckets?.over1000 ?? 0,
    },
  };
}

export async function getChunkTokenStats(): Promise<ChunkTokenStats> {
  return loadChunkTokenStats();
}

export type BoostFieldCoverage = {
  field: 'surface_type' | 'dwell_time_minutes' | 'dilution_ratio';
  chunksWithValue: number;
  totalChunks: number;
};

async function loadBoostFieldCoverage(): Promise<BoostFieldCoverage[]> {
  const supabase = getSupabaseServiceRoleClient();
  const fields: BoostFieldCoverage['field'][] = [
    'surface_type',
    'dwell_time_minutes',
    'dilution_ratio',
  ];

  type ChunkNotNullCountClient = {
    select(
      cols: string,
      opts: { count: 'exact'; head: true },
    ): {
      not(
        col: string,
        op: 'is',
        value: null,
      ): Promise<{ count: number | null; error: { message: string } | null }>;
    };
  };

  const [totalChunks, ...perField] = await Promise.all([
    countAllChunks(),
    ...fields.map(async (field) => {
      const { count, error } = await (
        supabase.schema('rag').from('document_chunk') as unknown as ChunkNotNullCountClient
      )
        .select('id', { count: 'exact', head: true })
        .not(`metadata->>${field}`, 'is', null);

      if (error) {
        throw new Error(`Failed to count ${field} coverage: ${error.message}`);
      }
      return count ?? 0;
    }),
  ]);

  return fields.map((field, index) => ({
    field,
    chunksWithValue: perField[index] ?? 0,
    totalChunks,
  }));
}

/** 15m cache — metadata enrichment is a manual, low-frequency edit. */
const getCachedBoostFieldCoverage = unstable_cache(
  loadBoostFieldCoverage,
  ['rag-boost-field-coverage'],
  { revalidate: 900 },
);

/**
 * B0-686 — how many chunks actually carry each boost field, so the boost card can't imply a rule
 * does useful work when nothing in the corpus can match it.
 */
export async function getBoostFieldCoverage(): Promise<BoostFieldCoverage[]> {
  return getCachedBoostFieldCoverage();
}

export type CorpusImprovementState = 'active' | 'migrated' | 'inactive';

export type CorpusImprovement = {
  label: string;
  status: string;
  state: CorpusImprovementState;
};

export type CorpusImprovementStatus = {
  chunking: RagChunkingConfig;
  boost: RagBoostConfig;
  improvements: CorpusImprovement[];
};

/**
 * B0-686 — the live state of the four corpus-quality improvements, replacing the hardcoded
 * "Pending migration" badges the page used to render.
 *
 * Three states, not a boolean: `active` (built and switched on), `migrated` (built, configurable,
 * deliberately left at its inert default), `inactive` (built, but nothing it needs is in place).
 */
export async function getCorpusImprovementStatus(): Promise<CorpusImprovementStatus> {
  const [chunking, boost] = await Promise.all([getRagChunkingConfig(), getRagBoostConfig()]);

  const headingAware = chunking.strategy === 'heading-aware';
  const boostRuleCount = [boost.surfaceType, boost.dwellTime, boost.dilutionRatio].filter(
    (weight) => weight > 0,
  ).length;

  const improvements: CorpusImprovement[] = [
    {
      label: 'Semantic chunking',
      status: headingAware ? 'Active — heading-aware' : 'Migrated — naive (default)',
      state: headingAware ? 'active' : 'migrated',
    },
    {
      label: 'Token budget + overlap',
      status: headingAware
        ? `Active — ${chunking.minTokens}–${chunking.maxTokens}, ${chunking.overlapTokens} overlap`
        : 'Inactive — naive strategy does no packing',
      state: headingAware ? 'active' : 'inactive',
    },
    {
      label: 'Domain metadata fields',
      status: 'Active — live',
      state: 'active',
    },
    {
      label: 'Similarity boost rules',
      status: boost.enabled
        ? `Active — ${boostRuleCount} rule${boostRuleCount === 1 ? '' : 's'}`
        : 'Migrated — disabled',
      state: boost.enabled ? 'active' : 'migrated',
    },
  ];

  return { chunking, boost, improvements };
}

export async function listEnrichmentDocuments(
  page: number,
  pageSize: number,
): Promise<{ documents: EnrichmentDocument[]; total: number }> {
  const supabase = getSupabaseServiceRoleClient();
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const [rowsResult, countResult] = await Promise.all([
    (
      supabase.schema('rag').from('document') as unknown as {
        select(cols: string): {
          order(col: string, opts: { ascending: boolean }): {
            range(from: number, to: number): Promise<{
              data: RawDocumentRow[] | null;
              error: { message: string } | null;
            }>;
          };
        };
      }
    )
      .select('id, document_key, title, document_kind, metadata')
      .order('title', { ascending: true })
      .range(from, to),

    (
      supabase.schema('rag').from('document') as unknown as {
        select(cols: string, opts: { count: 'exact'; head: true }): Promise<{
          count: number | null;
          error: { message: string } | null;
        }>;
      }
    ).select('id', { count: 'exact', head: true }),
  ]);

  if (rowsResult.error) {
    throw new Error(`Failed to list documents: ${rowsResult.error.message}`);
  }
  if (countResult.error) {
    throw new Error(`Failed to count documents: ${countResult.error.message}`);
  }

  const documents: EnrichmentDocument[] = (rowsResult.data ?? []).map((row) => {
    const meta = row.metadata ?? {};
    return {
      id: row.id,
      documentKey: row.document_key,
      title: row.title,
      documentKind: row.document_kind,
      surfaceType: typeof meta.surface_type === 'string' ? meta.surface_type : '',
      dwellTimeMinutes:
        meta.dwell_time_minutes != null ? String(meta.dwell_time_minutes) : '',
      dilutionRatio: typeof meta.dilution_ratio === 'string' ? meta.dilution_ratio : '',
    };
  });

  return { documents, total: countResult.count ?? 0 };
}
