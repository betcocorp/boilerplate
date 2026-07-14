'use server';

import { revalidatePath } from 'next/cache';

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import { assertSupabaseNoError as assertNoError } from '~/lib/utils';
import { PROMPT_CATEGORY_SLUGS } from '~/lib/constants/prompt-categories';

export async function updateTestItemCategory(
  testItemId: string,
  category: string,
): Promise<void> {
  if (!PROMPT_CATEGORY_SLUGS.includes(category as (typeof PROMPT_CATEGORY_SLUGS)[number])) {
    throw new Error(`Invalid category: ${category}`);
  }

  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_items')
    .update({ prompt_category: category })
    .eq('id', testItemId);

  assertNoError(result);
  revalidatePath('/admin/tests/failure-queue');
}
