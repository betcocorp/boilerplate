'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  approveCategoryLink,
  deleteCategoryLink,
  reassignCategoryLink,
} from '~/lib/category/curation-repository';

/**
 * B0-36 — server actions for the admin category-curation screen. Every mutation routes through the
 * curation repository, which records approvals/reassignments as `source='human_curated'` so the
 * delta sync (B0-37) treats them as frozen.
 */

const CURATION_PATH = '/admin/products/categories';

export type CurationActionState = { ok: boolean; error: string | null } | null;

const approveSchema = z.object({
  categoryKey: z.string().min(1),
  prodLineKey: z.string().min(1),
});

export async function approveCategoryLinkAction(
  _prev: CurationActionState,
  formData: FormData,
): Promise<CurationActionState> {
  const parsed = approveSchema.safeParse({
    categoryKey: String(formData.get('categoryKey') ?? ''),
    prodLineKey: String(formData.get('prodLineKey') ?? ''),
  });
  if (!parsed.success) return { ok: false, error: 'Invalid form data.' };
  try {
    await approveCategoryLink(parsed.data.categoryKey, parsed.data.prodLineKey);
    revalidatePath(CURATION_PATH);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Approve failed.' };
  }
}

const reassignSchema = z.object({
  prodLineKey: z.string().min(1),
  prodLineId: z.string().nullable(),
  fromCategoryKey: z.string(),
  toCategoryKey: z.string().min(1),
});

export async function reassignCategoryLinkAction(
  _prev: CurationActionState,
  formData: FormData,
): Promise<CurationActionState> {
  const prodLineId = formData.get('prodLineId');
  const parsed = reassignSchema.safeParse({
    prodLineKey: String(formData.get('prodLineKey') ?? ''),
    prodLineId: typeof prodLineId === 'string' && prodLineId ? prodLineId : null,
    fromCategoryKey: String(formData.get('fromCategoryKey') ?? ''),
    toCategoryKey: String(formData.get('toCategoryKey') ?? ''),
  });
  if (!parsed.success) return { ok: false, error: 'Invalid form data.' };
  if (parsed.data.toCategoryKey === parsed.data.fromCategoryKey) {
    return { ok: false, error: 'Pick a different category to reassign.' };
  }
  try {
    await reassignCategoryLink(parsed.data);
    revalidatePath(CURATION_PATH);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Reassign failed.' };
  }
}

const deleteSchema = z.object({
  categoryKey: z.string().min(1),
  prodLineKey: z.string().min(1),
});

export async function deleteCategoryLinkAction(
  _prev: CurationActionState,
  formData: FormData,
): Promise<CurationActionState> {
  const parsed = deleteSchema.safeParse({
    categoryKey: String(formData.get('categoryKey') ?? ''),
    prodLineKey: String(formData.get('prodLineKey') ?? ''),
  });
  if (!parsed.success) return { ok: false, error: 'Invalid form data.' };
  try {
    await deleteCategoryLink(parsed.data.categoryKey, parsed.data.prodLineKey);
    revalidatePath(CURATION_PATH);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Delete failed.' };
  }
}

const bulkReassignSchema = z.object({
  toCategoryKey: z.string().min(1),
  // Rows to reassign, encoded as `prodLineKey::prodLineId::fromCategoryKey` (id/from may be empty).
  rows: z.array(z.string().min(1)).min(1),
});

export type BulkReassignState = { ok: boolean; error: string | null; count: number } | null;

export async function bulkReassignCategoryLinksAction(
  _prev: BulkReassignState,
  formData: FormData,
): Promise<BulkReassignState> {
  const parsed = bulkReassignSchema.safeParse({
    toCategoryKey: String(formData.get('toCategoryKey') ?? ''),
    rows: formData.getAll('rows').map((r) => String(r)),
  });
  if (!parsed.success) return { ok: false, error: 'Select rows and a target category.', count: 0 };

  let count = 0;
  try {
    for (const encoded of parsed.data.rows) {
      const [prodLineKey, prodLineId, fromCategoryKey] = encoded.split('::');
      if (!prodLineKey) continue;
      await reassignCategoryLink({
        prodLineKey,
        prodLineId: prodLineId || null,
        fromCategoryKey: fromCategoryKey || '',
        toCategoryKey: parsed.data.toCategoryKey,
      });
      count += 1;
    }
    revalidatePath(CURATION_PATH);
    return { ok: true, error: null, count };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Bulk reassign failed.', count };
  }
}
