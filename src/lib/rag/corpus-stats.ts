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

type RawChunkRow = { token_count: number | null };
type RawDocumentRow = {
  id: string;
  document_key: string;
  title: string;
  document_kind: string;
  metadata: Record<string, unknown> | null;
};

export async function getChunkTokenStats(): Promise<ChunkTokenStats> {
  const supabase = getSupabaseServiceRoleClient();

  const { data, error } = await (
    supabase.schema('rag').from('document_chunk') as unknown as {
      select(cols: string): {
        limit(n: number): Promise<{ data: RawChunkRow[] | null; error: { message: string } | null }>;
      };
    }
  )
    .select('token_count')
    .limit(20000);

  if (error) {
    throw new Error(`Failed to fetch chunk token stats: ${error.message}`);
  }

  const counts = (data ?? []).map((row) => row.token_count ?? 0);

  if (counts.length === 0) {
    return {
      totalChunks: 0,
      avgTokens: 0,
      minTokens: 0,
      maxTokens: 0,
      distribution: { under100: 0, from100to299: 0, from300to599: 0, from600to999: 0, over1000: 0 },
    };
  }

  const total = counts.length;
  const avg = Math.round(counts.reduce((s, v) => s + v, 0) / total);

  return {
    totalChunks: total,
    avgTokens: avg,
    minTokens: Math.min(...counts),
    maxTokens: Math.max(...counts),
    distribution: {
      under100: counts.filter((v) => v < 100).length,
      from100to299: counts.filter((v) => v >= 100 && v < 300).length,
      from300to599: counts.filter((v) => v >= 300 && v < 600).length,
      from600to999: counts.filter((v) => v >= 600 && v < 1000).length,
      over1000: counts.filter((v) => v >= 1000).length,
    },
  };
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
