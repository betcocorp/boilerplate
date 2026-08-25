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
  deleteRoutingTestRun,
  insertRoutingTestItem,
  insertRoutingTestRun,
  updateRoutingTestItem,
} from './repository';
import { runRoutingTest } from './run';
import {
  firstIssueMessage,
  routingTestItemCreateSchema,
  routingTestItemDeleteSchema,
  routingTestRunDeleteSchema,
  routingTestItemUpdateSchema,
  routingTestModelTagSchema,
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

/**
 * B0-675 — the add dialog stays open for "create another", which a `redirect()` (real navigation)
 * would unconditionally break by unmounting the Radix `Dialog`. So unlike the other two item
 * actions below, this one is called directly from an `onSubmit` handler (not bound to a `<form
 * action>`, which would trigger React 19's auto-reset-on-success and desync the dialog's checkbox
 * state) and returns a discriminated result instead of redirecting to a `?success=`/`?error=` param.
 */
export type AddRoutingTestItemActionState =
  | { ok: true }
  | { ok: false; error: string };

export async function addRoutingTestItemAction(
  formData: FormData,
): Promise<AddRoutingTestItemActionState> {
  const parsed = routingTestItemCreateSchema.safeParse({
    prompt: formText(formData, 'prompt'),
    expectedAgent: formText(formData, 'expectedAgent'),
  });

  if (!parsed.success) {
    return { ok: false, error: firstIssueMessage(parsed.error) };
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
  return { ok: true };
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
 * B0-659/B0-667 — run every item through the selected router and hand back a plain serializable
 * result. Deliberately NOT a redirect action: the live result is ephemeral component state, exactly
 * as it was before B0-667 — re-running still replaces it inline, with no page navigation.
 *
 * B0-667 adds persistence as a SIDE EFFECT of an `ok: true` result: one `routing_test_runs` row plus
 * its `routing_test_run_items` snapshots (`insertRoutingTestRun`). This is deliberately best-effort
 * — swallow-and-log, the same convention `writeAuditLog` (`~/lib/audit/audit-log.ts`) already uses
 * for this file's other non-fatal side effects. The workbench is waiting on the run result itself;
 * a history-write failure is a real problem worth logging, but it must never turn a successful run
 * into an error response, and `ok: false` results (nothing ran) are never persisted.
 *
 * B0-671 — `modelTag` is only meaningful when `routerType === 'llm'`; an invalid/unknown tag is
 * silently ignored (treated as "no override chosen") rather than failing the whole run, since a
 * stale/mismatched client-side value should degrade to the default model, not block the test.
 */
export async function runRoutingTestAction(
  routerType: string,
  modelTag?: string,
): Promise<RoutingTestRunResult> {
  const parsedRouterType = routingTestRouterTypeSchema.safeParse(routerType);
  if (!parsedRouterType.success) {
    return {
      ok: false,
      routerType: 'keyword',
      error: 'Unknown router type — pick Keyword, Semantic, or LLM.',
    };
  }

  const parsedModelTag = routingTestModelTagSchema.safeParse(modelTag);

  const items = await listRoutingTestItems();

  let result: RoutingTestRunResult;
  try {
    result = await runRoutingTest(
      items,
      parsedRouterType.data,
      parsedModelTag.success ? parsedModelTag.data : undefined,
    );
  } catch (error) {
    return {
      ok: false,
      routerType: parsedRouterType.data,
      error: `Routing test run failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (result.ok) {
    try {
      await insertRoutingTestRun(result);
      revalidatePath(ROUTING_TEST_PATH);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'routing_test_run_persist_failed',
          routerType: result.routerType,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return result;
}

/** B0-678 — delete a routing test run by id, with redirect on success/failure. */
export async function deleteRoutingTestRunAction(formData: FormData) {
  const returnPath = normalizeReturnPath(formData.get('returnPath'));

  const parsed = routingTestRunDeleteSchema.safeParse({
    id: formText(formData, 'runId'),
  });

  if (!parsed.success) {
    redirect(
      encodeMessage(returnPath, 'error', firstIssueMessage(parsed.error)),
    );
  }

  const removed = await deleteRoutingTestRun(parsed.data.id);
  if (!removed) {
    redirect(
      encodeMessage(returnPath, 'error', 'That routing test run no longer exists.'),
    );
  }

  await writeAuditLog(
    'routing_test_run_deleted',
    {
      routing_test_run_id: parsed.data.id,
      actor: await currentAdminActor(),
    },
    { traceId: newCorrelationId() },
  );

  revalidatePath(ROUTING_TEST_PATH);
  redirect(encodeMessage(returnPath, 'success', 'Routing test run deleted.'));
}
