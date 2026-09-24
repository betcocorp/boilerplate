import { beforeEach, expect, it, vi } from 'vitest';

import { listWorkflowRunsByIds } from '~/lib/conversations/workflow-repository';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: vi.fn(),
}));

const query = vi.fn();
const from = vi.fn(() => ({ select: () => ({ in: query }) }));
const ids = Array.from(
  { length: 301 },
  (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue({
    from,
  } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>);
});

it('batches IDs into bounded filters and returns every matching row once', async () => {
  query.mockImplementation(async (_column: string, batch: string[]) => ({
    data: batch.map((id) => ({ id })),
    error: null,
  }));

  expect(await listWorkflowRunsByIds([...ids, ids[0]])).toEqual(
    ids.map((id) => ({ id })),
  );
  expect(from.mock.calls).toEqual(Array.from({ length: 3 }, () => ['workflow_runs']));
  expect(query.mock.calls).toEqual([
    ['id', ids.slice(0, 150)],
    ['id', ids.slice(150, 300)],
    ['id', ids.slice(300)],
  ]);
});

it('does not create a client for empty input', async () => {
  expect(await listWorkflowRunsByIds([])).toEqual([]);
  expect(getSupabaseServiceRoleClient).not.toHaveBeenCalled();
});

it('treats null data as empty but rejects a later batch error without querying further', async () => {
  query.mockResolvedValueOnce({ data: null, error: null });
  expect(await listWorkflowRunsByIds(ids.slice(0, 1))).toEqual([]);
  query.mockClear();
  query
    .mockResolvedValueOnce({ data: [{ id: ids[0] }], error: null })
    .mockResolvedValueOnce({ data: null, error: { message: 'Database unavailable' } });

  await expect(listWorkflowRunsByIds(ids)).rejects.toThrow('Database unavailable');
  expect(query).toHaveBeenCalledTimes(2);
});
