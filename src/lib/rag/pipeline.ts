import { syncDocumentChunkEmbeddings } from '~/lib/rag/embeddings';
import { withRetry } from '~/lib/utils';
import { clampPositiveInteger } from '~/lib/utils/params';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

const DEFAULT_LANGUAGE_CODE = 'EN';
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_BATCHES = 4;
const MAX_PROFILE_RUNS = 25;
const MAX_CHUNK_RUNS = 25;
const MAX_EMBEDDING_RUNS = 25;

type RagCountTableName =
  | 'source_record'
  | 'entity'
  | 'document'
  | 'document_chunk';
type RagLatestTableName = 'source_record' | 'document' | 'document_chunk';

type JsonObject = Record<string, unknown>;

type CountResponse = {
  count: number;
};

export type RagGenerationStatus = {
  env: {
    openAiConfigured: boolean;
    serviceRoleConfigured: boolean;
    syncApiKeyConfigured: boolean;
  };
  warnings: string[];
  counts: {
    sourceRecords: number;
    activeSourceRecords: number;
    inactiveSourceRecords: number;
    entities: number;
    documents: number;
    chunks: number;
    embeddedChunks: number;
    pendingChunks: number;
  };
  latest: {
    sourceRecordUpdatedAt: string | null;
    documentUpdatedAt: string | null;
    chunkUpdatedAt: string | null;
  };
};

export type RagPipelineIntent =
  | 'sync-documents'
  | 'sync-chunks'
  | 'sync-embeddings'
  | 'run-all';

export type RagPipelineRunOptions = {
  languageCode?: string;
  batchSize?: number;
  maxBatches?: number;
};

export type RagPipelineRunResult = {
  intent: RagPipelineIntent;
  languageCode: string;
  profileSyncResult: JsonObject | null;
  chunkSyncResult: JsonObject | null;
  embeddingRuns: number;
  embeddingResult: JsonObject | null;
  status: RagGenerationStatus;
};

function getLanguageCode(languageCode?: string) {
  return languageCode?.trim().toUpperCase() || DEFAULT_LANGUAGE_CODE;
}

function ragHeadIdCountQuery(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  tableName: RagCountTableName,
) {
  return supabase
    .schema('rag')
    .from(tableName)
    .select('id', { count: 'exact', head: true });
}

type RagHeadIdCountQuery = ReturnType<typeof ragHeadIdCountQuery>;

async function getCount(
  tableName: RagCountTableName,
  filters?: (query: RagHeadIdCountQuery) => RagHeadIdCountQuery,
) {
  const supabase = getSupabaseServiceRoleClient();
  const baseQuery = ragHeadIdCountQuery(supabase, tableName);
  const query = filters ? filters(baseQuery) : baseQuery;
  const { count, error } = await query;

  if (error) {
    throw new Error(`Failed to count ${tableName}: ${error.message}`);
  }

  return (count ?? 0) as CountResponse['count'];
}

async function safeCount(
  tableName: RagCountTableName,
  warnings: string[],
  filters?: (query: RagHeadIdCountQuery) => RagHeadIdCountQuery,
) {
  try {
    return await getCount(tableName, filters);
  } catch (error) {
    warnings.push(
      error instanceof Error
        ? error.message
        : `Failed to count ${tableName}.`,
    );

    return 0;
  }
}

async function getLatestUpdatedAt(tableName: RagLatestTableName) {
  const supabase = getSupabaseServiceRoleClient();
  const rag = supabase.schema('rag');
  const { data, error } = await rag
    .from(tableName)
    .select('updated_at')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to inspect ${tableName}: ${error.message}`);
  }

  if (!data || typeof data.updated_at !== 'string') {
    return null;
  }

  return data.updated_at;
}

async function safeLatestUpdatedAt(
  tableName: RagLatestTableName,
  warnings: string[],
) {
  try {
    return await getLatestUpdatedAt(tableName);
  } catch (error) {
    warnings.push(
      error instanceof Error
        ? error.message
        : `Failed to inspect ${tableName}.`,
    );

    return null;
  }
}

function normalizeJsonObject(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function readJsonNumber(
  value: JsonObject | null,
  key: string,
): number | null {
  const candidate = value?.[key];

  return typeof candidate === 'number' && Number.isFinite(candidate)
    ? candidate
    : null;
}

function mergeSyncResults(
  accumulated: JsonObject | null,
  next: JsonObject | null,
  passCount: number,
  sumKeys: readonly string[],
) {
  const merged: JsonObject = {
    ...(accumulated ?? {}),
    ...(next ?? {}),
    passes_run: passCount,
  };

  for (const key of sumKeys) {
    merged[key] =
      (readJsonNumber(accumulated, key) ?? 0) + (readJsonNumber(next, key) ?? 0);
  }

  return merged;
}

function mergeChunkSyncResults(
  accumulated: JsonObject | null,
  next: JsonObject | null,
  passCount: number,
) {
  return mergeSyncResults(accumulated, next, passCount, [
    'documents_processed',
    'active_documents_processed',
    'inactive_documents_processed',
    'chunks_upserted',
    'stale_chunks_deleted',
    'inactive_chunks_deleted',
  ]);
}

function mergeProfileSyncResults(
  accumulated: JsonObject | null,
  next: JsonObject | null,
  passCount: number,
) {
  return mergeSyncResults(accumulated, next, passCount, [
    'source_rows_processed',
    'source_records_upserted',
    'entities_upserted',
    'documents_upserted',
    'source_records_deactivated',
  ]);
}

export async function getRagGenerationStatus(): Promise<RagGenerationStatus> {
  const warnings: string[] = [];
  const [
    sourceRecords,
    activeSourceRecords,
    inactiveSourceRecords,
    entities,
    documents,
    chunks,
    embeddedChunks,
    pendingChunks,
    sourceRecordUpdatedAt,
    documentUpdatedAt,
    chunkUpdatedAt,
  ] = await Promise.all([
    safeCount('source_record', warnings),
    safeCount(
      'source_record',
      warnings,
      (query) => (query as typeof query & { eq: (column: string, value: unknown) => typeof query }).eq('is_active', true),
    ),
    safeCount(
      'source_record',
      warnings,
      (query) => (query as typeof query & { eq: (column: string, value: unknown) => typeof query }).eq('is_active', false),
    ),
    safeCount('entity', warnings),
    safeCount('document', warnings),
    safeCount('document_chunk', warnings),
    safeCount('document_chunk', warnings, (query) =>
      (query as typeof query & { not(col: string, op: string, val: null): typeof query })
        .not('embedding_large', 'is', null),
    ),
    safeCount('document_chunk', warnings, (query) =>
      (query as typeof query & { is(col: string, val: null): typeof query })
        .is('embedding_large', null),
    ),
    safeLatestUpdatedAt('source_record', warnings),
    safeLatestUpdatedAt('document', warnings),
    safeLatestUpdatedAt('document_chunk', warnings),
  ]);

  return {
    env: {
      openAiConfigured: Boolean(process.env.OPENAI_API_KEY),
      serviceRoleConfigured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      syncApiKeyConfigured: Boolean(process.env.RAG_SYNC_API_KEY),
    },
    warnings: Array.from(new Set(warnings)),
    counts: {
      sourceRecords,
      activeSourceRecords,
      inactiveSourceRecords,
      entities,
      documents,
      chunks,
      embeddedChunks,
      pendingChunks,
    },
    latest: {
      sourceRecordUpdatedAt,
      documentUpdatedAt,
      chunkUpdatedAt,
    },
  };
}

async function syncLegacyProductProfiles(languageCode: string) {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await withRetry(() =>
    supabase
      .schema('rag')
      .rpc('sync_legacy_product_profiles', { p_language_code: languageCode }),
  );

  if (error) {
    throw new Error(`Failed to sync RAG documents: ${error.message}`);
  }

  return normalizeJsonObject(data);
}

async function syncLegacyProductChunks(languageCode: string) {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await withRetry(() =>
    supabase
      .schema('rag')
      .rpc('sync_legacy_product_profile_chunks', { p_language_code: languageCode }),
  );

  if (error) {
    throw new Error(`Failed to sync RAG chunks: ${error.message}`);
  }

  return normalizeJsonObject(data);
}

async function syncSdsChunks(languageCode: string) {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await withRetry(() =>
    supabase
      .schema('rag')
      .rpc('sync_sds_chunks', { p_language_code: languageCode }),
  );

  if (error) {
    throw new Error(`Failed to sync SDS chunks: ${error.message}`);
  }

  return normalizeJsonObject(data);
}

async function syncEfficacyChunks(languageCode: string) {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await withRetry(() =>
    supabase.schema('rag').rpc('sync_efficacy_chunks', { p_language_code: languageCode }),
  );

  if (error) {
    throw new Error(`Failed to sync efficacy chunks: ${error.message}`);
  }

  return normalizeJsonObject(data);
}

export async function runRagPipeline(
  intent: RagPipelineIntent,
  options: RagPipelineRunOptions = {},
): Promise<RagPipelineRunResult> {
  const languageCode = getLanguageCode(options.languageCode);
  const batchSize = clampPositiveInteger(options.batchSize, DEFAULT_BATCH_SIZE);
  const maxBatches = clampPositiveInteger(options.maxBatches, DEFAULT_MAX_BATCHES);

  let profileSyncResult: JsonObject | null = null;
  let chunkSyncResult: JsonObject | null = null;
  let embeddingResult: JsonObject | null = null;
  let profileRuns = 0;
  let chunkRuns = 0;
  let embeddingRuns = 0;

  if (intent === 'sync-documents' || intent === 'run-all') {
    if (intent === 'sync-documents') {
      profileSyncResult = await syncLegacyProductProfiles(languageCode);
    } else {
      while (profileRuns < MAX_PROFILE_RUNS) {
        const result = await syncLegacyProductProfiles(languageCode);

        profileRuns += 1;
        profileSyncResult = mergeProfileSyncResults(
          profileSyncResult,
          result,
          profileRuns,
        );

        if (
          (readJsonNumber(result, 'remaining_source_rows') ?? 0) === 0 &&
          (readJsonNumber(result, 'remaining_deactivations') ?? 0) === 0
        ) {
          break;
        }

        if (
          (readJsonNumber(result, 'source_rows_processed') ?? 0) === 0 &&
          (readJsonNumber(result, 'source_records_deactivated') ?? 0) === 0
        ) {
          break;
        }
      }

      const remainingSourceRows =
        readJsonNumber(profileSyncResult, 'remaining_source_rows') ?? 0;
      const remainingDeactivations =
        readJsonNumber(profileSyncResult, 'remaining_deactivations') ?? 0;

      if (remainingSourceRows > 0 || remainingDeactivations > 0) {
        throw new Error(
          `Document sync reached the safety cap after ${profileRuns} pass${
            profileRuns === 1 ? '' : 'es'
          } with ${remainingSourceRows} source row${
            remainingSourceRows === 1 ? '' : 's'
          } and ${remainingDeactivations} deactivation${
            remainingDeactivations === 1 ? '' : 's'
          } still pending. Run the document sync again before chunking.`,
        );
      }
    }
  }

  if (intent === 'sync-chunks' || intent === 'run-all') {
    if (intent === 'sync-chunks') {
      const plpResult = await syncLegacyProductChunks(languageCode);
      const sdsResult = await syncSdsChunks(languageCode);
      const efficacyResult = await syncEfficacyChunks(languageCode);
      chunkRuns = 1;
      chunkSyncResult = mergeChunkSyncResults(
        mergeChunkSyncResults(
          mergeChunkSyncResults(null, plpResult, 1),
          sdsResult,
          1,
        ),
        efficacyResult,
        1,
      );
    } else {
      // PLP loop — drain product_line_profile chunks
      let plpRuns = 0;
      let plpSyncResult: JsonObject | null = null;
      while (plpRuns < MAX_CHUNK_RUNS) {
        const result = await syncLegacyProductChunks(languageCode);

        plpRuns += 1;
        plpSyncResult = mergeChunkSyncResults(plpSyncResult, result, plpRuns);

        if (
          (readJsonNumber(result, 'remaining_documents') ?? 0) === 0 ||
          (readJsonNumber(result, 'documents_processed') ?? 0) === 0
        ) {
          break;
        }
      }

      // SDS loop — drain SDS chunks
      let sdsRuns = 0;
      let sdsSyncResult: JsonObject | null = null;
      while (sdsRuns < MAX_CHUNK_RUNS) {
        const result = await syncSdsChunks(languageCode);

        sdsRuns += 1;
        sdsSyncResult = mergeChunkSyncResults(sdsSyncResult, result, sdsRuns);

        if (
          (readJsonNumber(result, 'remaining_documents') ?? 0) === 0 ||
          (readJsonNumber(result, 'documents_processed') ?? 0) === 0
        ) {
          break;
        }
      }

      // Efficacy loop — drain efficacy chunks
      let efficacyRuns = 0;
      let efficacySyncResult: JsonObject | null = null;
      while (efficacyRuns < MAX_CHUNK_RUNS) {
        const result = await syncEfficacyChunks(languageCode);

        efficacyRuns += 1;
        efficacySyncResult = mergeChunkSyncResults(
          efficacySyncResult,
          result,
          efficacyRuns,
        );

        if (
          (readJsonNumber(result, 'remaining_documents') ?? 0) === 0 ||
          (readJsonNumber(result, 'documents_processed') ?? 0) === 0
        ) {
          break;
        }
      }

      chunkRuns = Math.max(plpRuns, sdsRuns, efficacyRuns);
      chunkSyncResult = mergeChunkSyncResults(
        mergeChunkSyncResults(plpSyncResult, sdsSyncResult, chunkRuns),
        efficacySyncResult,
        chunkRuns,
      );

      const remainingPlp = readJsonNumber(plpSyncResult, 'remaining_documents') ?? 0;
      const remainingSds = readJsonNumber(sdsSyncResult, 'remaining_documents') ?? 0;
      const remainingEfficacy =
        readJsonNumber(efficacySyncResult, 'remaining_documents') ?? 0;
      const totalRemaining = remainingPlp + remainingSds + remainingEfficacy;

      if (totalRemaining > 0) {
        throw new Error(
          `Chunk sync reached the safety cap after ${chunkRuns} pass${
            chunkRuns === 1 ? '' : 'es'
          } with ${totalRemaining} document${
            totalRemaining === 1 ? '' : 's'
          } still pending (${remainingPlp} PLP, ${remainingSds} SDS, ${remainingEfficacy} efficacy). Run the chunk step again before embeddings.`,
        );
      }
    }
  }

  if (intent === 'sync-embeddings' || intent === 'run-all') {
    while (embeddingRuns < MAX_EMBEDDING_RUNS) {
      const result = await syncDocumentChunkEmbeddings({
        batchSize,
        maxBatches,
      });

      embeddingRuns += 1;
      embeddingResult = result as unknown as JsonObject;

      if (
        intent === 'sync-embeddings' ||
        result.remainingChunks === 0 ||
        result.chunksEmbedded === 0
      ) {
        break;
      }
    }
  }

  return {
    intent,
    languageCode,
    profileSyncResult,
    chunkSyncResult,
    embeddingRuns,
    embeddingResult,
    status: await getRagGenerationStatus(),
  };
}
