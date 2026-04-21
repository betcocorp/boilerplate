'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { parseCsvColumnNames, parseTestCsvContent } from '~/lib/tests/csv';
import {
  createTestRecord,
  createTestResult,
  deleteTestById,
  deleteTestResultById,
  getTestItemsByTestId,
  getTestResultById,
  insertTestItems,
  updateTestRecord,
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

export async function uploadTestCsvAction(formData: FormData) {
  const file = formData.get('dataset');
  const nameValue = formData.get('name');
  const testName = typeof nameValue === 'string' && nameValue.trim() ? nameValue.trim() : null;

  if (!(file instanceof File) || file.size === 0) {
    redirect(encodeMessage('error', 'Choose a CSV file before uploading.'));
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const content = toUtf8Text(fileBytes);
  const parsedRows = parseTestCsvContent(content);
  const columnNames = parseCsvColumnNames(content);

  if (parsedRows.length === 0) {
    redirect(
      encodeMessage(
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
      'success',
      `Uploaded ${file.name} and stored ${parsedRows.length} test prompts.`,
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
