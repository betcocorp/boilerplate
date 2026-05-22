'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { SME_AGENT_IDS } from '~/lib/agents/agent-registry';
import {
  parseCsvColumnNames,
  parseExpectedShouldAnswerFromForm,
  parseTestCsvContent,
} from '~/lib/tests/csv';
import { buildManualAddTestItemPayload } from '~/lib/tests/manual-add-payload';
import {
  createTestRecord,
  createTestResult,
  deleteTestById,
  deleteTestItemForTest,
  deleteTestResultById,
  getMaxRowIndexForTest,
  getTestById,
  getTestItemsByTestId,
  getTestResultById,
  insertTestItems,
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

export async function runTestAction(formData: FormData) {
  const testId = formData.get('testId');
  if (typeof testId !== 'string' || !testId.trim()) {
    redirect(encodeMessage('/admin/tests', 'error', 'Missing test id.'));
  }

  const items = await getTestItemsByTestId(testId);
  if (items.length === 0) {
    redirect(encodeMessage(`/admin/tests/${testId}`, 'error', 'This test has no items to run.'));
  }

  const testResult = await createTestResult({
    test_id: testId,
    status: 'queued',
    run_mode: 'full',
    total_items: items.length,
    passed_items: 0,
    failed_items: 0,
    started_at: new Date().toISOString(),
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
