'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
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
