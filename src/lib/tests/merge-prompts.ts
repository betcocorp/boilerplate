import { normalizeGoldenPrompt } from './golden-set';

/**
 * B0-1098 — pure planner for "Add to existing test set".
 *
 * Given the ids the user selected on a source test, the source's items and the target's items,
 * decide which source items get copied into the target and at which `row_index`. Pure so it is
 * unit-testable without a database; `addPromptsToTestAction` does the reads/writes around it.
 *
 * Rules:
 * - Only selected ids that exist in `sourceItems` are considered, in `selectedIds` order
 *   (mirrors `createTestFromPromptsAction`). Ids not found are counted in `missingCount`.
 * - An item is skipped as a duplicate when its normalized prompt (`normalizeGoldenPrompt`:
 *   trim + lowercase — the same rule golden-origin matching uses) already exists in the target
 *   OR was already planned earlier in this same merge.
 * - Kept items receive consecutive `row_index` values starting at `nextRowIndex`.
 */

export type MergeSourceItem = { id: string; prompt: string };
export type MergeTargetItem = { prompt: string };

export type PlanPromptMergeInput<TItem extends MergeSourceItem> = {
  selectedIds: string[];
  sourceItems: TItem[];
  targetItems: MergeTargetItem[];
  /** The `row_index` to assign to the first inserted item (caller passes max + 1). */
  nextRowIndex: number;
};

export type PlannedPromptInsert<TItem extends MergeSourceItem> = {
  item: TItem;
  row_index: number;
};

export type PromptMergePlan<TItem extends MergeSourceItem> = {
  toInsert: Array<PlannedPromptInsert<TItem>>;
  /** Selected source items dropped because the target (or an earlier selection) already has that prompt. */
  skippedDuplicateCount: number;
  /** Selected ids that do not belong to the source test. */
  missingCount: number;
};

export function planPromptMerge<TItem extends MergeSourceItem>(
  input: PlanPromptMergeInput<TItem>,
): PromptMergePlan<TItem> {
  const sourceItemsById = new Map(input.sourceItems.map((item) => [item.id, item]));
  const seenPrompts = new Set(
    input.targetItems.map((item) => normalizeGoldenPrompt(item.prompt)),
  );

  const toInsert: Array<PlannedPromptInsert<TItem>> = [];
  let skippedDuplicateCount = 0;
  let missingCount = 0;
  let rowIndex = input.nextRowIndex;

  for (const id of input.selectedIds) {
    const item = sourceItemsById.get(id);
    if (!item) {
      missingCount += 1;
      continue;
    }

    const key = normalizeGoldenPrompt(item.prompt);
    if (seenPrompts.has(key)) {
      skippedDuplicateCount += 1;
      continue;
    }

    seenPrompts.add(key);
    toInsert.push({ item, row_index: rowIndex });
    rowIndex += 1;
  }

  return { toInsert, skippedDuplicateCount, missingCount };
}
