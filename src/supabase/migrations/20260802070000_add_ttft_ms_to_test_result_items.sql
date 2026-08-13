ALTER TABLE public.test_result_items
  ADD COLUMN IF NOT EXISTS ttft_ms integer;

COMMENT ON COLUMN public.test_result_items.ttft_ms IS
  'Time to first streamed token/chunk from the assistant response, in milliseconds. Null for rows predating this column or where no streaming delta was observed before the turn completed/errored.';
