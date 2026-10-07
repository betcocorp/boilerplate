-- B0-1014 — distinguish an infrastructure refusal from a quality failure.
--
-- On 2026-09-14 the OpenAI organization ran out of credits mid-afternoon. Every subsequent eval
-- item threw "You have no credits remaining", was stored as passed = false with the raw provider
-- text in error_message, and was counted as a quality failure. The 2026-09-15 00:00 UTC golden
-- sweep therefore recorded 0% on all five golden sets while the sweep ledger reported
-- success_rate = 1. Nothing in the schema could tell the two apart.
--
-- Nullable on purpose: NULL means "no provider fault recorded", which is the correct reading for
-- every historical row and for every item that genuinely failed on quality.
alter table public.test_result_items
  add column if not exists provider_fault text;

comment on column public.test_result_items.provider_fault is
  'B0-1014 — set when the item never got an answer because the model provider refused the request '
  '(insufficient_quota | invalid_credentials | rate_limited | provider_unavailable). NULL means the '
  'item was actually answered and graded, so its passed value is a real quality verdict. Written by '
  'classifyProviderFault in ~/lib/tests/provider-fault.ts.';

-- Partial index: the only read is the per-run roll-up, which counts faulted rows for one
-- test_result_id. Partial keeps it tiny, since the overwhelming majority of rows are NULL.
create index if not exists test_result_items_provider_fault_idx
  on public.test_result_items (test_result_id)
  where provider_fault is not null;
