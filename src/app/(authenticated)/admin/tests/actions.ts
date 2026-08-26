'use server';

import { getServerSession } from 'next-auth';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { SME_AGENT_IDS } from '~/lib/agents/agent-registry';
import { APP_VERSION } from '~/lib/app-version';
import { writeAuditLog } from '~/lib/audit/audit-log';
import { authOptions } from '~/lib/auth';
import { newCorrelationId } from '~/lib/observability/correlation-id';
import { GOLDEN_TIERS, type GoldenTier } from '~/lib/tests/golden-set';
import { updateTierTarget } from '~/lib/tests/tier-targets';
import supportedModels from '~/lib/constants/models';
import type { RouterTypeOverride } from '~/lib/workflows/product-support/run-product-support-workflow';
import {
  parseCsvColumnNames,
  parseExpectedCriteriaFromForm,
  parseExpectedShouldAnswerFromForm,
  parsePriority,
  parseShouldCiteFromForm,
  parseTestCsvContent,
} from '~/lib/tests/csv';
import {
  buildEditedTestItemPayload,
  buildManualAddTestItemPayload,
} from '~/lib/tests/manual-add-payload';
import {
  archiveTest,
  createTestRecord,
  createTestResult,
  deleteTestById,
  deleteTestItemForTest,
  deleteTestResultById,
  getMaxRowIndexForTest,
  getTestById,
  getTestItemById,
  getTestItemsByTestId,
  getTestResultById,
  insertTestItems,
  unarchiveTest,
  updateTestItemForTest,
  updateTestRecord,
  updateTestResult,
} from '~/lib/tests/repository';
import { uploadTestCsvToS3 } from '~/lib/tests/storage';

function normalizeReturnPath(value: FormDataEntryValue | null, fallback: string) {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }

  const candidate = value.trim();
  return candidate.startsWith('/admin/tests') ? candidate : fallback;
}

function encodeMessage(path: string, kind: 'success' | 'error', text: string) {
  const url = new URL(path, 'http://localhost');
  url.searchParams.set(kind, text);
  return `${url.pathname}${url.search}`;
}

function toUtf8Text(bytes: Uint8Array) {
  return new TextDecoder('utf-8').decode(bytes);
}

/** Surfaces a failed dataset create/upload as a toast message instead of an unhandled 500. */
function describeUploadError(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not save this test dataset: ${detail}`;
}

/** Trimmed form string, or null when absent/blank — a cleared input clears the stored value. */
function optionalFormText(formData: FormData, name: string): string | null {
  const raw = formData.get(name);
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/**
 * The golden-set expectation fields shared by the add and edit prompt dialogs
 * (same names as the CSV columns in `~/lib/tests/template`).
 */
function readConceptExpectationFields(formData: FormData) {
  const shouldCiteRaw = formData.get('shouldCite');
  const expectedCriteriaRaw = formData.get('expectedCriteria');
  return {
    expected_concepts: optionalFormText(formData, 'expectedConcepts'),
    minimum_concepts: optionalFormText(formData, 'minimumConcepts'),
    // B0-615 — blank clears the row back to legacy behavior-only grading (empty array),
    // matching how every other field here treats a cleared input.
    expected_criteria:
      typeof expectedCriteriaRaw === 'string'
        ? parseExpectedCriteriaFromForm(expectedCriteriaRaw)
        : [],
    expected_sources: optionalFormText(formData, 'expectedSources'),
    should_cite:
      typeof shouldCiteRaw === 'string'
        ? parseShouldCiteFromForm(shouldCiteRaw)
        : null,
  };
}

function parseIntendedAgentField(
  value: FormDataEntryValue | null,
): { ok: true; id: string | null } | { ok: false } {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: true, id: null };
  }
  const id = value.trim();
  if (!(SME_AGENT_IDS as readonly string[]).includes(id)) {
    return { ok: false };
  }
  return { ok: true, id };
}

export async function uploadTestCsvAction(formData: FormData) {
  const returnPath = normalizeReturnPath(formData.get('returnPath'), '/admin/tests');
  const file = formData.get('dataset');
  const nameValue = formData.get('name');
  const testName = typeof nameValue === 'string' && nameValue.trim() ? nameValue.trim() : null;

  const intendedParsed = parseIntendedAgentField(formData.get('intendedAgent'));
  if (!intendedParsed.ok) {
    redirect(
      encodeMessage(
        '/admin/tests',
        'error',
        'Invalid intended agent. Choose an agent from the list or clear the field.',
      ),
    );
  }
  const intended_agent = intendedParsed.id;

  const hasCsvFile = file instanceof File && file.size > 0;

  if (!hasCsvFile) {
    if (!testName) {
      redirect(
        encodeMessage(
          '/admin/tests',
          'error',
          'Enter a test name to create an empty dataset, or attach a CSV file.',
        ),
      );
    }

    try {
      await createTestRecord({
        name: testName,
        source_file_name: '(no CSV)',
        source_bucket: 'ad-hoc',
        source_key: 'none',
        row_count: 0,
        status: 'ready',
        intended_agent,
        metadata: {},
      });
    } catch (error) {
      redirect(
        encodeMessage('/admin/tests', 'error', describeUploadError(error)),
      );
    }

    revalidatePath('/admin/tests');
    redirect(
      encodeMessage(
        '/admin/tests',
        'success',
        intended_agent
          ? `Created empty test set "${testName}" (intended agent: ${intended_agent}). Add prompts on the detail page.`
          : `Created empty test set "${testName}". Add prompts on the detail page.`,
      ),
    );
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const content = toUtf8Text(fileBytes);
  const parsedRows = parseTestCsvContent(content);
  const columnNames = parseCsvColumnNames(content);

  if (parsedRows.length === 0) {
    redirect(
      encodeMessage(
        '/admin/tests',
        'error',
        'No usable prompt rows were found in this CSV. Expected a `question` or `prompt` column.',
      ),
    );
  }

  try {
    const initialTest = await createTestRecord({
      name: testName || file.name.replace(/\.csv$/i, ''),
      source_file_name: file.name,
      source_bucket: 'retool-360',
      source_key: 'pending',
      row_count: 0,
      status: 'uploading',
      intended_agent,
      metadata: {
        column_names: columnNames,
        content_type: file.type || 'text/csv',
        file_size_bytes: file.size,
      },
    });

    const uploaded = await uploadTestCsvToS3({
      testId: initialTest.id,
      fileName: file.name,
      bytes: fileBytes,
      contentType: file.type || 'text/csv',
    });

    const testItems = parsedRows.map((row) => ({
      test_id: initialTest.id,
      row_index: row.rowIndex,
      prompt: row.prompt,
      expected_should_answer: row.expectedShouldAnswer,
      expected_result_type: row.expectedResultType,
      expected_canonical_product: row.expectedCanonicalProduct,
      expected_reason_code: row.expectedReasonCode,
      source: row.source,
      priority: row.priority,
      ideal_response: row.idealResponse,
      expected_concepts: row.expectedConcepts,
      minimum_concepts: row.minimumConcepts,
      expected_criteria: row.expectedCriteria,
      expected_sources: row.expectedSources,
      should_cite: row.shouldCite,
      input_payload: row.inputPayload,
      metadata: row.metadata,
    }));

    await insertTestItems(testItems);
    await updateTestRecord(initialTest.id, {
      source_bucket: uploaded.bucket,
      source_key: uploaded.key,
      row_count: parsedRows.length,
      status: 'ready',
      intended_agent,
      metadata: {
        column_names: columnNames,
        content_type: file.type || 'text/csv',
        file_size_bytes: file.size,
        parsed_rows: parsedRows.length,
      },
    });
  } catch (error) {
    redirect(
      encodeMessage('/admin/tests', 'error', describeUploadError(error)),
    );
  }

  revalidatePath('/admin/tests');
  redirect(
    encodeMessage(
      '/admin/tests',
      'success',
      `Uploaded ${file.name} and stored ${parsedRows.length} test prompts.`,
    ),
  );
}

export async function addTestItemAction(formData: FormData) {
  const returnPath = normalizeReturnPath(
    formData.get('returnPath'),
    '/admin/tests',
  );
  const testId = formData.get('testId');
  if (typeof testId !== 'string' || !testId.trim()) {
    redirect(encodeMessage(returnPath, 'error', 'Missing test id.'));
  }

  const promptRaw = formData.get('prompt');
  const prompt = typeof promptRaw === 'string' ? promptRaw.trim() : '';
  if (!prompt) {
    redirect(
      encodeMessage(returnPath, 'error', 'Enter a prompt before adding a row.'),
    );
  }

  let test;
  try {
    test = await getTestById(testId);
  } catch {
    redirect(encodeMessage(returnPath, 'error', 'Test not found.'));
  }

  const expectedModeRaw = formData.get('expectedShouldAnswer');
  const expected_should_answer =
    typeof expectedModeRaw === 'string'
      ? parseExpectedShouldAnswerFromForm(expectedModeRaw)
      : null;

  const expectedResultTypeRaw = formData.get('expectedResultType');
  const expected_result_type =
    typeof expectedResultTypeRaw === 'string' && expectedResultTypeRaw.trim()
      ? expectedResultTypeRaw.trim()
      : null;

  const expectedCanonicalRaw = formData.get('expectedCanonicalProduct');
  const expected_canonical_product =
    typeof expectedCanonicalRaw === 'string' && expectedCanonicalRaw.trim()
      ? expectedCanonicalRaw.trim()
      : null;

  const expectedReasonRaw = formData.get('expectedReasonCode');
  const expected_reason_code =
    typeof expectedReasonRaw === 'string' && expectedReasonRaw.trim()
      ? expectedReasonRaw.trim()
      : null;

  const sourceRaw = formData.get('source');
  const source =
    typeof sourceRaw === 'string' && sourceRaw.trim() ? sourceRaw.trim() : null;

  const priorityRaw = formData.get('priority');
  const priority =
    typeof priorityRaw === 'string' ? parsePriority(priorityRaw) : null;

  const idealResponseRaw = formData.get('idealResponse');
  const ideal_response =
    typeof idealResponseRaw === 'string' && idealResponseRaw.trim()
      ? idealResponseRaw.trim()
      : null;

  const conceptExpectations = readConceptExpectationFields(formData);

  const productMentionRaw = formData.get('productMention');
  const questionCategoryRaw = formData.get('questionCategory');
  const sourceStyleRaw = formData.get('sourceStyle');

  const { input_payload, metadata } = buildManualAddTestItemPayload({
    prompt,
    expected_should_answer,
    productMention:
      typeof productMentionRaw === 'string' && productMentionRaw.trim()
        ? productMentionRaw.trim()
        : null,
    questionCategory:
      typeof questionCategoryRaw === 'string' && questionCategoryRaw.trim()
        ? questionCategoryRaw.trim()
        : null,
    sourceStyle:
      typeof sourceStyleRaw === 'string' && sourceStyleRaw.trim()
        ? sourceStyleRaw.trim()
        : null,
  });

  const maxRow = await getMaxRowIndexForTest(testId);
  const row_index = maxRow + 1;

  await insertTestItems([
    {
      test_id: testId,
      row_index,
      prompt,
      expected_should_answer,
      expected_result_type,
      expected_canonical_product,
      expected_reason_code,
      source,
      priority,
      ideal_response,
      ...conceptExpectations,
      input_payload,
      metadata,
    },
  ]);

  await updateTestRecord(testId, {
    row_count: test.row_count + 1,
  });

  revalidatePath('/admin/tests');
  revalidatePath(`/admin/tests/${testId}`);
  redirect(
    encodeMessage(
      returnPath,
      'success',
      `Added prompt row ${row_index}.`,
    ),
  );
}

export async function updateTestItemAction(formData: FormData) {
  const testIdRaw = formData.get('testId');
  const testId =
    typeof testIdRaw === 'string' && testIdRaw.trim() ? testIdRaw.trim() : '';
  const returnPath = normalizeReturnPath(
    formData.get('returnPath'),
    testId ? `/admin/tests/${testId}` : '/admin/tests',
  );
  if (!testId) {
    redirect(encodeMessage(returnPath, 'error', 'Missing test id.'));
  }

  const testItemIdRaw = formData.get('testItemId');
  const testItemId =
    typeof testItemIdRaw === 'string' && testItemIdRaw.trim()
      ? testItemIdRaw.trim()
      : '';
  if (!testItemId) {
    redirect(encodeMessage(returnPath, 'error', 'Missing prompt id.'));
  }

  const promptRaw = formData.get('prompt');
  const prompt = typeof promptRaw === 'string' ? promptRaw.trim() : '';
  if (!prompt) {
    redirect(
      encodeMessage(returnPath, 'error', 'Enter a prompt before saving.'),
    );
  }

  const existing = await getTestItemById(testItemId).catch(() => null);
  if (!existing || existing.test_id !== testId) {
    redirect(
      encodeMessage(returnPath, 'error', 'That prompt was not found on this dataset.'),
    );
  }

  const expectedModeRaw = formData.get('expectedShouldAnswer');
  const expected_should_answer =
    typeof expectedModeRaw === 'string'
      ? parseExpectedShouldAnswerFromForm(expectedModeRaw)
      : null;

  const expectedResultTypeRaw = formData.get('expectedResultType');
  const expected_result_type =
    typeof expectedResultTypeRaw === 'string' && expectedResultTypeRaw.trim()
      ? expectedResultTypeRaw.trim()
      : null;

  const expectedCanonicalRaw = formData.get('expectedCanonicalProduct');
  const expected_canonical_product =
    typeof expectedCanonicalRaw === 'string' && expectedCanonicalRaw.trim()
      ? expectedCanonicalRaw.trim()
      : null;

  const expectedReasonRaw = formData.get('expectedReasonCode');
  const expected_reason_code =
    typeof expectedReasonRaw === 'string' && expectedReasonRaw.trim()
      ? expectedReasonRaw.trim()
      : null;

  const sourceRaw = formData.get('source');
  const source =
    typeof sourceRaw === 'string' && sourceRaw.trim() ? sourceRaw.trim() : null;

  // Cleared inputs resolve to null so an edit can clear the stored values.
  const priorityRaw = formData.get('priority');
  const priority =
    typeof priorityRaw === 'string' ? parsePriority(priorityRaw) : null;

  const idealResponseRaw = formData.get('idealResponse');
  const ideal_response =
    typeof idealResponseRaw === 'string' && idealResponseRaw.trim()
      ? idealResponseRaw.trim()
      : null;

  const conceptExpectations = readConceptExpectationFields(formData);

  const productMentionRaw = formData.get('productMention');
  const questionCategoryRaw = formData.get('questionCategory');
  const sourceStyleRaw = formData.get('sourceStyle');

  const { input_payload, metadata } = buildEditedTestItemPayload({
    prompt,
    expected_should_answer,
    productMention:
      typeof productMentionRaw === 'string' && productMentionRaw.trim()
        ? productMentionRaw.trim()
        : null,
    questionCategory:
      typeof questionCategoryRaw === 'string' && questionCategoryRaw.trim()
        ? questionCategoryRaw.trim()
        : null,
    sourceStyle:
      typeof sourceStyleRaw === 'string' && sourceStyleRaw.trim()
        ? sourceStyleRaw.trim()
        : null,
    existingInputPayload: existing.input_payload,
    existingMetadata: existing.metadata,
  });

  const updated = await updateTestItemForTest(testItemId, testId, {
    prompt,
    expected_should_answer,
    expected_result_type,
    expected_canonical_product,
    expected_reason_code,
    source,
    priority,
    ideal_response,
    ...conceptExpectations,
    input_payload,
    metadata,
  });

  if (!updated) {
    redirect(
      encodeMessage(returnPath, 'error', 'That prompt was not found on this dataset.'),
    );
  }

  revalidatePath('/admin/tests');
  revalidatePath(`/admin/tests/${testId}`);
  revalidatePath(`/admin/tests/${testId}/items/${testItemId}`);
  redirect(
    encodeMessage(
      returnPath,
      'success',
      `Updated prompt row ${existing.row_index}.`,
    ),
  );
}

export async function runTestAction(formData: FormData) {
  const testId = formData.get('testId');
  if (typeof testId !== 'string' || !testId.trim()) {
    redirect(encodeMessage('/admin/tests', 'error', 'Missing test id.'));
  }

  const items = await getTestItemsByTestId(testId);
  if (items.length === 0) {
    redirect(encodeMessage(`/admin/tests/${testId}`, 'error', 'This test has no items to run.'));
  }

  /**
   * Model the run against a specific chat model. Tags map to concrete models in
   * resolveResponsesModel(); 'preview' is the configured default.
   *
   * Read from the SAME `~/lib/constants/models` list the form's <select> renders. This was a
   * hardcoded ['preview','gpt-4o','gpt-4.1'], so any newer model offered by the dropdown fell
   * through to the `: 'preview'` branch — the run silently executed on the preview default while
   * recording a model the user never picked. An unknown tag still falls back to 'preview' (a
   * hand-crafted POST is not a reason to 500), but the allow-list can no longer drift from the UI.
   */
  const ALLOWED_MODEL_TAGS: readonly string[] = [
    'preview',
    ...supportedModels.map((m) => m.name),
  ];
  const rawModelTag = formData.get('modelTag');
  const modelTag =
    typeof rawModelTag === 'string' && ALLOWED_MODEL_TAGS.includes(rawModelTag)
      ? rawModelTag
      : 'preview';

  // B0-600 / B0-603 — opt-in validator pass, so a validator A/B run can be started from the UI.
  // Unchecked box means absent, matching every run created before this field existed.
  const useValidator = formData.get('useValidator') === 'on';

  // B0-681 — opt-in router override; "Router: default" submits an empty string, which leaves
  // `routerType` out of `run_options` entirely so the run falls back to the settings-driven router,
  // matching every run created before this field existed.
  const ROUTER_TYPE_OVERRIDES: readonly RouterTypeOverride[] = ['keyword', 'semantic', 'llm'];
  const rawRouterType = formData.get('routerType');
  const routerType =
    typeof rawRouterType === 'string' &&
    (ROUTER_TYPE_OVERRIDES as readonly string[]).includes(rawRouterType)
      ? (rawRouterType as RouterTypeOverride)
      : undefined;

  const testResult = await createTestResult({
    test_id: testId,
    status: 'queued',
    run_mode: 'full',
    total_items: items.length,
    passed_items: 0,
    failed_items: 0,
    started_at: new Date().toISOString(),
    run_options: routerType
      ? { modelTag, useValidator, routerType }
      : { modelTag, useValidator },
    app_version: APP_VERSION,
    triggered_by: await currentRunActor(),
    summary: {
      completed_items: 0,
      total_items: items.length,
      progress_percent: 0,
      runner_state: 'queued',
    },
  });

  await updateTestRecord(testId, {
    status: 'running',
  });

  revalidatePath('/admin/tests');
  revalidatePath(`/admin/tests/${testId}`);
  redirect(
    encodeMessage(
      `/admin/tests/${testId}/runs/${testResult.id}`,
      'success',
      `Run started for ${items.length} prompts.`,
    ),
  );
}

export async function runSearchEvalAction(formData: FormData) {
  const testId = formData.get('testId');
  if (typeof testId !== 'string' || !testId.trim()) {
    redirect(encodeMessage('/admin/tests', 'error', 'Missing test id.'));
  }

  const items = await getTestItemsByTestId(testId);
  if (items.length === 0) {
    redirect(encodeMessage(`/admin/tests/${testId}`, 'error', 'This test has no items to run.'));
  }

  const useHybrid = formData.get('useHybrid') === 'on';
  const useReranker = formData.get('useReranker') === 'on';
  const useMultiIntent = formData.get('useMultiIntent') === 'on';

  const testResult = await createTestResult({
    test_id: testId,
    status: 'queued',
    run_mode: 'search',
    total_items: items.length,
    passed_items: 0,
    failed_items: 0,
    started_at: new Date().toISOString(),
    run_options: { useHybrid, useReranker, useMultiIntent },
    app_version: APP_VERSION,
    triggered_by: await currentRunActor(),
    summary: {
      completed_items: 0,
      total_items: items.length,
      progress_percent: 0,
      runner_state: 'queued',
    },
  });

  revalidatePath('/admin/tests');
  revalidatePath(`/admin/tests/${testId}`);
  redirect(
    encodeMessage(
      `/admin/tests/${testId}/search-runs/${testResult.id}`,
      'success',
      `Search eval started for ${items.length} prompts.`,
    ),
  );
}

export async function deleteSearchRunAction(formData: FormData) {
  const testId = formData.get('testId');
  const runId = formData.get('runId');

  if (typeof testId !== 'string' || !testId.trim()) {
    redirect(encodeMessage('/admin/tests', 'error', 'Missing test id.'));
  }

  const returnPath = normalizeReturnPath(
    formData.get('returnPath'),
    `/admin/tests/${testId}`,
  );

  if (typeof runId !== 'string' || !runId.trim()) {
    redirect(encodeMessage(returnPath, 'error', 'Missing run id.'));
  }

  const run = await getTestResultById(runId).catch(() => null);
  if (!run || run.test_id !== testId) {
    redirect(encodeMessage(returnPath, 'error', 'Run not found for this dataset.'));
  }

  await deleteTestResultById(runId);
  await updateTestRecord(testId, { status: 'ready' });

  revalidatePath('/admin/tests');
  revalidatePath(`/admin/tests/${testId}`);
  redirect(encodeMessage(returnPath, 'success', 'Search eval run deleted.'));
}

export async function createTestFromPromptsAction(formData: FormData) {
  const sourceTestIdRaw = formData.get('sourceTestId');
  const sourceTestId =
    typeof sourceTestIdRaw === 'string' && sourceTestIdRaw.trim()
      ? sourceTestIdRaw.trim()
      : null;
  const sourceReturnPath = sourceTestId
    ? `/admin/tests/${sourceTestId}`
    : '/admin/tests';
  const returnPath = normalizeReturnPath(
    formData.get('returnPath'),
    sourceReturnPath,
  );

  if (!sourceTestId) {
    redirect(encodeMessage(returnPath, 'error', 'Missing source test id.'));
  }

  const nameRaw = formData.get('name');
  const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
  if (!name) {
    redirect(
      encodeMessage(returnPath, 'error', 'Enter a name for the new test set.'),
    );
  }

  const intendedParsed = parseIntendedAgentField(formData.get('intendedAgent'));
  if (!intendedParsed.ok) {
    redirect(
      encodeMessage(
        returnPath,
        'error',
        'Invalid intended agent. Choose an agent from the list or clear the field.',
      ),
    );
  }
  const intended_agent = intendedParsed.id;

  const rawIds = formData.getAll('testItemId');
  const selectedIds = Array.from(
    new Set(
      rawIds
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value) => value.length > 0),
    ),
  );

  if (selectedIds.length === 0) {
    redirect(
      encodeMessage(
        returnPath,
        'error',
        'Select at least one prompt to copy into the new test.',
      ),
    );
  }

  let sourceTest;
  try {
    sourceTest = await getTestById(sourceTestId);
  } catch {
    redirect(encodeMessage(returnPath, 'error', 'Source test not found.'));
  }

  const sourceItems = await getTestItemsByTestId(sourceTestId);
  const sourceItemsById = new Map(sourceItems.map((item) => [item.id, item]));
  const orderedSelections = selectedIds
    .map((id) => sourceItemsById.get(id))
    .filter((item): item is (typeof sourceItems)[number] => Boolean(item));

  if (orderedSelections.length === 0) {
    redirect(
      encodeMessage(
        returnPath,
        'error',
        'None of the selected prompts belong to this dataset.',
      ),
    );
  }

  const newTest = await createTestRecord({
    name,
    source_file_name: `(derived from ${sourceTest.name})`,
    source_bucket: 'derived',
    source_key: sourceTestId,
    row_count: 0,
    status: 'ready',
    intended_agent,
    metadata: {
      derived_from_test_id: sourceTestId,
      derived_from_test_name: sourceTest.name,
      derived_item_count: orderedSelections.length,
    },
  });

  const newItems = orderedSelections.map((item, index) => ({
    test_id: newTest.id,
    row_index: index + 1,
    prompt: item.prompt,
    expected_should_answer: item.expected_should_answer,
    expected_result_type: item.expected_result_type,
    expected_canonical_product: item.expected_canonical_product,
    expected_reason_code: item.expected_reason_code,
    source: item.source,
    priority: item.priority,
    ideal_response: item.ideal_response,
    expected_concepts: item.expected_concepts,
    minimum_concepts: item.minimum_concepts,
    expected_criteria: item.expected_criteria,
    expected_sources: item.expected_sources,
    should_cite: item.should_cite,
    input_payload: item.input_payload,
    metadata: item.metadata,
  }));

  await insertTestItems(newItems);
  await updateTestRecord(newTest.id, {
    row_count: newItems.length,
  });

  revalidatePath('/admin/tests');
  revalidatePath(`/admin/tests/${sourceTestId}`);
  redirect(
    encodeMessage(
      `/admin/tests/${newTest.id}`,
      'success',
      `Created "${name}" with ${newItems.length} prompt${
        newItems.length === 1 ? '' : 's'
      } from ${sourceTest.name}.`,
    ),
  );
}

export async function deleteTestAction(formData: FormData) {
  const returnPath = normalizeReturnPath(formData.get('returnPath'), '/admin/tests');
  const testId = formData.get('testId');
  if (typeof testId !== 'string' || !testId.trim()) {
    redirect(encodeMessage(returnPath, 'error', 'Missing test id.'));
  }

  await deleteTestById(testId);
  revalidatePath('/admin/tests');
  redirect(encodeMessage(returnPath, 'success', 'Test deleted.'));
}

export async function deleteTestItemAction(formData: FormData) {
  const testId = formData.get('testId');
  const testItemId = formData.get('testItemId');

  if (typeof testId !== 'string' || !testId.trim()) {
    redirect(encodeMessage('/admin/tests', 'error', 'Missing test id.'));
  }

  const returnPath = normalizeReturnPath(
    formData.get('returnPath'),
    `/admin/tests/${testId}`,
  );

  if (typeof testItemId !== 'string' || !testItemId.trim()) {
    redirect(encodeMessage(returnPath, 'error', 'Missing prompt id.'));
  }

  const removed = await deleteTestItemForTest(testItemId, testId);
  if (!removed) {
    redirect(
      encodeMessage(returnPath, 'error', 'That prompt was not found on this dataset.'),
    );
  }

  revalidatePath('/admin/tests');
  revalidatePath(`/admin/tests/${testId}`);
  redirect(encodeMessage(returnPath, 'success', 'Prompt removed from dataset.'));
}

export async function deleteTestRunAction(formData: FormData) {
  const testId = formData.get('testId');
  const runId = formData.get('runId');

  if (typeof testId !== 'string' || !testId.trim()) {
    redirect(encodeMessage('/admin/tests', 'error', 'Missing test id.'));
  }

  const returnPath = normalizeReturnPath(
    formData.get('returnPath'),
    `/admin/tests/${testId}`,
  );

  if (typeof runId !== 'string' || !runId.trim()) {
    redirect(encodeMessage(returnPath, 'error', 'Missing run id.'));
  }

  const run = await getTestResultById(runId).catch(() => null);
  if (!run || run.test_id !== testId) {
    redirect(encodeMessage(returnPath, 'error', 'Run not found for this dataset.'));
  }

  await deleteTestResultById(runId);
  await updateTestRecord(testId, {
    status: 'ready',
  });

  revalidatePath('/admin/tests');
  revalidatePath(`/admin/tests/${testId}`);
  revalidatePath(`/admin/tests/${testId}/runs/${runId}`);
  redirect(encodeMessage(returnPath, 'success', 'Run deleted.'));
}

/** Same actor convention as `~/lib/recommendations/review-actions.ts`. */
async function currentAdminActor(): Promise<string> {
  const session = await getServerSession(authOptions);
  return session?.user?.email ?? 'admin';
}

/**
 * B0-687 — who to stamp on `test_results.triggered_by`. Unlike `currentAdminActor()` (whose
 * `'admin'` fallback keeps audit rows non-null) this returns null when there is no session email,
 * so the reports index shows "—" rather than attributing the run to a placeholder that isn't a real
 * account.
 */
async function currentRunActor(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  return session?.user?.email ?? null;
}

/**
 * B0-572 — mark/unmark a test set as part of the gating golden set. Audited with old and
 * new values. The B0-572 rule (every golden-set item must carry a priority) is enforced as
 * a VISIBLE data error by the golden-set reader's validation list, not by blocking the
 * toggle — blocking would hide exactly the items an admin needs to go fix.
 */
export async function setTestGoldenAction(formData: FormData) {
  const returnPath = normalizeReturnPath(formData.get('returnPath'), '/admin/tests');
  const testId = formData.get('testId');
  if (typeof testId !== 'string' || !testId.trim()) {
    redirect(encodeMessage(returnPath, 'error', 'Missing test id.'));
  }
  const isGolden = formData.get('isGolden') === 'true';

  const test = await getTestById(testId).catch(() => null);
  if (!test) {
    redirect(encodeMessage(returnPath, 'error', 'Test not found.'));
  }

  if (test.is_golden === isGolden) {
    redirect(
      encodeMessage(
        returnPath,
        'success',
        `"${test.name}" is already ${isGolden ? 'in' : 'out of'} the golden set.`,
      ),
    );
  }

  await updateTestRecord(testId, { is_golden: isGolden });

  const actor = await currentAdminActor();
  await writeAuditLog(
    'golden_set_membership_changed',
    {
      test_id: testId,
      test_name: test.name,
      actor,
      old_is_golden: test.is_golden,
      new_is_golden: isGolden,
    },
    { traceId: newCorrelationId() },
  );

  revalidatePath('/admin/tests');
  revalidatePath(`/admin/tests/${testId}`);
  redirect(
    encodeMessage(
      returnPath,
      'success',
      isGolden
        ? `"${test.name}" added to the golden set.`
        : `"${test.name}" removed from the golden set.`,
    ),
  );
}

/**
 * B0-573 — edit one tier's pass-rate target / gate flag / label. Audited with old AND new
 * values (`audit_logs.payload.old` / `.new`), so a target change is reconstructable.
 */
export async function updateTierTargetAction(formData: FormData) {
  const returnPath = normalizeReturnPath(formData.get('returnPath'), '/admin/tests');

  const tierRaw = formData.get('tier');
  const tierNumber = typeof tierRaw === 'string' ? Number.parseInt(tierRaw, 10) : NaN;
  if (!(GOLDEN_TIERS as readonly number[]).includes(tierNumber)) {
    redirect(encodeMessage(returnPath, 'error', 'Invalid tier.'));
  }
  const tier = tierNumber as GoldenTier;

  const targetRaw = formData.get('targetPassRate');
  const targetPassRate = typeof targetRaw === 'string' ? Number.parseFloat(targetRaw) : NaN;
  if (!Number.isFinite(targetPassRate) || targetPassRate < 0 || targetPassRate > 1) {
    redirect(
      encodeMessage(returnPath, 'error', 'Target pass rate must be between 0 and 1.'),
    );
  }

  const isGate = formData.get('isGate') === 'on';

  const labelRaw = formData.get('label');
  const label = typeof labelRaw === 'string' ? labelRaw.trim() : '';
  if (!label) {
    redirect(encodeMessage(returnPath, 'error', 'Enter a label for the tier.'));
  }

  const { previous, next } = await updateTierTarget(tier, {
    targetPassRate,
    isGate,
    label,
  });

  const actor = await currentAdminActor();
  await writeAuditLog(
    'tier_target_changed',
    {
      tier,
      actor,
      old: {
        target_pass_rate: previous.targetPassRate,
        is_gate: previous.isGate,
        label: previous.label,
      },
      new: {
        target_pass_rate: next.targetPassRate,
        is_gate: next.isGate,
        label: next.label,
      },
    },
    { traceId: newCorrelationId() },
  );

  revalidatePath('/admin/tests');
  redirect(
    encodeMessage(
      returnPath,
      'success',
      `Tier ${tier} target updated to ${(next.targetPassRate * 100).toFixed(0)}%${next.isGate ? ' (gate)' : ''}.`,
    ),
  );
}

const TEST_RUN_NOTES_MAX_LENGTH = 32_000;

export type UpdateTestRunNotesResult =
  | { ok: true }
  | { ok: false; error: string };

export async function updateTestRunNotesAction(input: {
  testId: string;
  runId: string;
  notes: string;
}): Promise<UpdateTestRunNotesResult> {
  const { testId, runId, notes } = input;

  if (typeof testId !== 'string' || !testId.trim()) {
    return { ok: false, error: 'Missing test id.' };
  }
  if (typeof runId !== 'string' || !runId.trim()) {
    return { ok: false, error: 'Missing run id.' };
  }
  if (typeof notes !== 'string') {
    return { ok: false, error: 'Invalid notes.' };
  }

  const trimmed = notes.trim();
  if (trimmed.length > TEST_RUN_NOTES_MAX_LENGTH) {
    return {
      ok: false,
      error: `Notes must be at most ${TEST_RUN_NOTES_MAX_LENGTH.toLocaleString()} characters.`,
    };
  }

  const run = await getTestResultById(runId).catch(() => null);
  if (!run || run.test_id !== testId) {
    return { ok: false, error: 'Run not found for this dataset.' };
  }

  await updateTestResult(runId, {
    notes: trimmed.length > 0 ? trimmed : null,
  });

  revalidatePath('/admin/tests');
  revalidatePath(`/admin/tests/${testId}`);
  revalidatePath(`/admin/tests/${testId}/runs/${runId}`);

  return { ok: true };
}

export async function archiveTestAction(formData: FormData) {
  const returnPath = normalizeReturnPath(formData.get('returnPath'), '/admin/tests');
  const testId = formData.get('testId');
  if (typeof testId !== 'string' || !testId.trim()) {
    redirect(encodeMessage(returnPath, 'error', 'Missing test id.'));
  }

  const isArchiving = formData.get('isArchiving') === 'true';

  if (isArchiving) {
    await archiveTest(testId);
  } else {
    await unarchiveTest(testId);
  }

  revalidatePath('/admin/tests');
  revalidatePath('/admin/tests/archived');
  redirect(
    encodeMessage(
      returnPath,
      'success',
      isArchiving ? 'Test archived.' : 'Test restored.',
    ),
  );
}
