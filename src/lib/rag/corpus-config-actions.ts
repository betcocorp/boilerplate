'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  RAG_BOOST_WEIGHT_BOUNDS,
  RAG_CHUNK_STRATEGIES,
  RAG_CHUNK_TOKEN_BOUNDS,
} from '~/lib/settings/rag-corpus-config';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

const saveDomainMetadataSchema = z.object({
  documentId: z.string().uuid(),
  surfaceType: z.string().max(200),
  dwellTimeMinutes: z.string(),
  dilutionRatio: z.string().max(200),
});

export type SaveDomainMetadataState = {
  ok: boolean;
  error: string | null;
  documentId: string;
} | null;

export async function saveDomainMetadataAction(
  _prev: SaveDomainMetadataState,
  formData: FormData,
): Promise<SaveDomainMetadataState> {
  const raw = {
    documentId: String(formData.get('documentId') ?? ''),
    surfaceType: String(formData.get('surfaceType') ?? ''),
    dwellTimeMinutes: String(formData.get('dwellTimeMinutes') ?? ''),
    dilutionRatio: String(formData.get('dilutionRatio') ?? ''),
  };

  const parsed = saveDomainMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'Invalid form data.', documentId: raw.documentId };
  }

  const { documentId, surfaceType, dwellTimeMinutes, dilutionRatio } = parsed.data;
  const supabase = getSupabaseServiceRoleClient();

  const { data: existing, error: readError } = await (
    supabase.schema('rag').from('document') as unknown as {
      select(cols: string): {
        eq(col: string, val: string): {
          single(): Promise<{
            data: { metadata: Record<string, unknown> | null } | null;
            error: { message: string } | null;
          }>;
        };
      };
    }
  )
    .select('metadata')
    .eq('id', documentId)
    .single();

  if (readError || !existing) {
    return { ok: false, error: 'Document not found.', documentId };
  }

  const currentMeta = existing.metadata ?? {};
  const dwellNum = Number(dwellTimeMinutes);
  const newMeta: Record<string, unknown> = {
    ...currentMeta,
    surface_type: surfaceType.trim() || null,
    dwell_time_minutes: Number.isFinite(dwellNum) && dwellNum > 0 ? dwellNum : null,
    dilution_ratio: dilutionRatio.trim() || null,
  };

  const { error: updateError } = await (
    supabase.schema('rag').from('document') as unknown as {
      update(data: Record<string, unknown>): {
        eq(col: string, val: string): Promise<{ error: { message: string } | null }>;
      };
    }
  )
    .update({ metadata: newMeta })
    .eq('id', documentId);

  if (updateError) {
    return { ok: false, error: updateError.message, documentId };
  }

  revalidatePath('/admin/products/rag/chunking');
  return { ok: true, error: null, documentId };
}

/**
 * B0-686 — chunking config and boost weights persist to `public.settings`, replacing the
 * copy-this-SQL-into-a-migration panels these cards used to render.
 *
 * Read-path note: `settings-service` caches each key for 30s, so a value saved here can take up to
 * 30 seconds to be observed by a running read path. `resetSettingsCacheForTest` is a test seam and
 * is deliberately not called from these actions.
 */
export type SaveCorpusSettingsState =
  | { ok: true; error: null; savedAt: number }
  | { ok: false; error: string; savedAt: null }
  | null;

function invalid(error: string): SaveCorpusSettingsState {
  return { ok: false, error, savedAt: null };
}

/**
 * Writes `value` (and `updated_at`) for keys the migration already created. A missing key is an
 * error state, never a silent insert: `value_type`/`allowed_values` are owned by the migration and
 * an inserted row would carry neither.
 */
async function updateExistingSettings(
  values: Record<string, string>,
): Promise<{ error: string | null }> {
  const supabase = getSupabaseServiceRoleClient();
  const keys = Object.keys(values);

  const { data: existing, error: readError } = await supabase
    .from('settings')
    .select('key')
    .in('key', keys);

  if (readError) {
    return { error: `Failed to read settings: ${readError.message}` };
  }

  const present = new Set((existing ?? []).map((row) => row.key));
  const missing = keys.filter((key) => !present.has(key));
  if (missing.length > 0) {
    return {
      error: `Settings row(s) not found: ${missing.join(', ')}. Apply the B0-686 migration first.`,
    };
  }

  const updatedAt = new Date().toISOString();
  for (const [key, value] of Object.entries(values)) {
    const { error: updateError } = await supabase
      .from('settings')
      .update({ value, updated_at: updatedAt })
      .eq('key', key);

    if (updateError) {
      return { error: `Failed to update ${key}: ${updateError.message}` };
    }
  }

  return { error: null };
}

const positiveIntInRange = (min: number, max: number) =>
  z.coerce.number().int().positive().min(min).max(max);

const saveChunkingConfigSchema = z
  .object({
    strategy: z.enum(RAG_CHUNK_STRATEGIES),
    minTokens: positiveIntInRange(
      RAG_CHUNK_TOKEN_BOUNDS.minTokens.min,
      RAG_CHUNK_TOKEN_BOUNDS.minTokens.max,
    ),
    maxTokens: positiveIntInRange(
      RAG_CHUNK_TOKEN_BOUNDS.maxTokens.min,
      RAG_CHUNK_TOKEN_BOUNDS.maxTokens.max,
    ),
    // Overlap alone may legitimately be 0 (no overlap), so it is not `.positive()`.
    overlapTokens: z.coerce
      .number()
      .int()
      .min(RAG_CHUNK_TOKEN_BOUNDS.overlapTokens.min)
      .max(RAG_CHUNK_TOKEN_BOUNDS.overlapTokens.max),
  })
  .refine((v) => v.minTokens <= v.maxTokens, {
    message: 'Min tokens must be less than or equal to max tokens.',
    path: ['minTokens'],
  });

export async function saveChunkingConfigAction(
  _prev: SaveCorpusSettingsState,
  formData: FormData,
): Promise<SaveCorpusSettingsState> {
  const parsed = saveChunkingConfigSchema.safeParse({
    strategy: String(formData.get('strategy') ?? ''),
    minTokens: String(formData.get('minTokens') ?? ''),
    maxTokens: String(formData.get('maxTokens') ?? ''),
    overlapTokens: String(formData.get('overlapTokens') ?? ''),
  });

  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.message ?? 'Invalid chunking configuration.');
  }

  const { strategy, minTokens, maxTokens, overlapTokens } = parsed.data;
  const { error } = await updateExistingSettings({
    RAG_CHUNK_STRATEGY: strategy,
    RAG_CHUNK_MIN_TOKENS: String(minTokens),
    RAG_CHUNK_MAX_TOKENS: String(maxTokens),
    RAG_CHUNK_OVERLAP_TOKENS: String(overlapTokens),
  });

  if (error) return invalid(error);

  revalidatePath('/admin/products/rag/chunking');
  return { ok: true, error: null, savedAt: Date.now() };
}

const boostWeight = z.coerce
  .number()
  .min(RAG_BOOST_WEIGHT_BOUNDS.min)
  .max(RAG_BOOST_WEIGHT_BOUNDS.max);

const saveBoostRulesSchema = z.object({
  enabled: z.union([z.literal('true'), z.literal('false')]),
  surfaceType: boostWeight,
  dwellTime: boostWeight,
  dilutionRatio: boostWeight,
});

export async function saveBoostRulesAction(
  _prev: SaveCorpusSettingsState,
  formData: FormData,
): Promise<SaveCorpusSettingsState> {
  const parsed = saveBoostRulesSchema.safeParse({
    // An unchecked checkbox submits nothing, so absence means disabled.
    enabled: formData.get('enabled') === 'true' ? 'true' : 'false',
    surfaceType: String(formData.get('surfaceType') ?? ''),
    dwellTime: String(formData.get('dwellTime') ?? ''),
    dilutionRatio: String(formData.get('dilutionRatio') ?? ''),
  });

  if (!parsed.success) {
    return invalid(
      parsed.error.issues[0]?.message ??
        `Boost weights must be between ${RAG_BOOST_WEIGHT_BOUNDS.min} and ${RAG_BOOST_WEIGHT_BOUNDS.max}.`,
    );
  }

  const { enabled, surfaceType, dwellTime, dilutionRatio } = parsed.data;
  const { error } = await updateExistingSettings({
    RAG_BOOST_ENABLED: enabled,
    RAG_BOOST_SURFACE_TYPE: surfaceType.toFixed(2),
    RAG_BOOST_DWELL_TIME: dwellTime.toFixed(2),
    RAG_BOOST_DILUTION_RATIO: dilutionRatio.toFixed(2),
  });

  if (error) return invalid(error);

  revalidatePath('/admin/products/rag/chunking');
  return { ok: true, error: null, savedAt: Date.now() };
}
