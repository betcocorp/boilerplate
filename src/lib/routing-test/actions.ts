'use server';

import { getServerSession } from 'next-auth';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { writeAuditLog } from '~/lib/audit/audit-log';
import { authOptions } from '~/lib/auth';
import { newCorrelationId } from '~/lib/observability/correlation-id';

import { ROUTING_TEST_PATH } from './constants';
import {
  listRoutingTestItems,
  deleteRoutingTestItem,
  insertRoutingTestItem,
  updateRoutingTestItem,
} from './repository';
import { runRoutingTest } from './run';
import {
  firstIssueMessage,
  routingTestItemCreateSchema,
  routingTestItemDeleteSchema,
  routingTestItemUpdateSchema,
  routingTestRouterTypeSchema,
} from './schemas';
import type { RoutingTestRunResult } from './types';

/** Only paths inside the routing-test surface are accepted as redirect targets. */
function normalizeReturnPath(value: FormDataEntryValue | null): string {
  if (typeof value !== 'string' || !value.trim()) {
    return ROUTING_TEST_PATH;
  }

  const candidate = value.trim();
  return candidate.startsWith(ROUTING_TEST_PATH) ? candidate : ROUTING_TEST_PATH;
}

/** Same `?success=` / `?error=` convention as the test-runner actions. */
function encodeMessage(
  path: string,
  kind: 'success' | 'error',
  text: string,
): string {
  const url = new URL(path, 'http://localhost');
  url.searchParams.set(kind, text);
  return `${url.pathname}${url.search}`;
}

/** Same actor convention as `~/app/(authenticated)/admin/tests/actions.ts`. */
async function currentAdminActor(): Promise<string> {
  const session = await getServerSession(authOptions);
  return session?.user?.email ?? 'admin';
}

function formText(formData: FormData, name: string): string {
  const raw = formData.get(name);
  return typeof raw === 'string' ? raw : '';
}

export async function addRoutingTestItemAction(formData: FormData) {
  const returnPath = normalizeReturnPath(formData.get('returnPath'));

  const parsed = routingTestItemCreateSchema.safeParse({
    prompt: formText(formData, 'prompt'),
    expectedAgent: formText(formData, 'expectedAgent'),
  });

  if (!parsed.success) {
    redirect(
      encodeMessage(returnPath, 'error', firstIssueMessage(parsed.error)),
    );
  }

  const created = await insertRoutingTestItem({
    prompt: parsed.data.prompt,
    expected_agent: parsed.data.expectedAgent,
  });

  await writeAuditLog(
    'routing_test_item_added',
    {
      routing_test_item_id: created.id,
      expected_agent: created.expected_agent,
      actor: await currentAdminActor(),
    },
    { traceId: newCorrelationId() },
  );

  revalidatePath(ROUTING_TEST_PATH);
  redirect(encodeMessage(returnPath, 'success', 'Routing test item added.'));
}

export async function updateRoutingTestItemAction(formData: FormData) {
  const returnPath = normalizeReturnPath(formData.get('returnPath'));

  const parsed = routingTestItemUpdateSchema.safeParse({
    id: formText(formData, 'itemId'),
    prompt: formText(formData, 'prompt'),
    expectedAgent: formText(formData, 'expectedAgent'),
  });

  if (!parsed.success) {
    redirect(
      encodeMessage(returnPath, 'error', firstIssueMessage(parsed.error)),
    );
  }

  const updated = await updateRoutingTestItem(parsed.data.id, {
    prompt: parsed.data.prompt,
    expected_agent: parsed.data.expectedAgent,
  });

  if (!updated) {
    redirect(
      encodeMessage(returnPath, 'error', 'That routing test item no longer exists.'),
    );
  }

  await writeAuditLog(
    'routing_test_item_updated',
    {
      routing_test_item_id: updated.id,
      expected_agent: updated.expected_agent,
      actor: await currentAdminActor(),
    },
    { traceId: newCorrelationId() },
  );

  revalidatePath(ROUTING_TEST_PATH);
  redirect(encodeMessage(returnPath, 'success', 'Routing test item updated.'));
}

export async function deleteRoutingTestItemAction(formData: FormData) {
  const returnPath = normalizeReturnPath(formData.get('returnPath'));

  const parsed = routingTestItemDeleteSchema.safeParse({
    id: formText(formData, 'itemId'),
  });

  if (!parsed.success) {
    redirect(
      encodeMessage(returnPath, 'error', firstIssueMessage(parsed.error)),
    );
  }

  const removed = await deleteRoutingTestItem(parsed.data.id);
  if (!removed) {
    redirect(
      encodeMessage(returnPath, 'error', 'That routing test item no longer exists.'),
    );
  }

  await writeAuditLog(
    'routing_test_item_deleted',
    {
      routing_test_item_id: parsed.data.id,
      actor: await currentAdminActor(),
    },
    { traceId: newCorrelationId() },
  );

  revalidatePath(ROUTING_TEST_PATH);
  redirect(encodeMessage(returnPath, 'success', 'Routing test item removed.'));
}

/**
 * B0-659 — run every item through the selected router and hand back a plain serializable result.
 * Deliberately NOT a redirect action: results are ephemeral component state, so nothing is
 * persisted and no run-history row is written.
 */
export async function runRoutingTestAction(
  routerType: string,
): Promise<RoutingTestRunResult> {
  const parsedRouterType = routingTestRouterTypeSchema.safeParse(routerType);
  if (!parsedRouterType.success) {
    return {
      ok: false,
      routerType: 'keyword',
      error: 'Unknown router type — pick Keyword, Semantic, or LLM.',
    };
  }

  const items = await listRoutingTestItems();

  try {
    return await runRoutingTest(items, parsedRouterType.data);
  } catch (error) {
    return {
      ok: false,
      routerType: parsedRouterType.data,
      error: `Routing test run failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
