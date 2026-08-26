-- B0-683: expose the root-cause reason and suggested fix as separate columns.
-- ~/lib/tests/failure-root-cause.ts already stores both individually in
-- ai_suggestions.metadata (`rootCause`, `suggestedFix`) alongside the
-- pre-joined `content` column; the failure-queue UI wants to render them as
-- two distinct labeled values instead of one concatenated block. Appended at
-- the end per Postgres's CREATE OR REPLACE VIEW column-order rule — verified
-- against the live column order (see 20260821190000's header comment for the
-- prompt_category drift this view already hit once).

BEGIN;

CREATE OR REPLACE VIEW public.latest_failed_test_result_items AS
SELECT DISTINCT ON (tri.test_item_id)
  tri.id,
  tri.test_result_id,
  tri.test_item_id,
  tri.row_index,
  tri.passed,
  tri.status,
  tri.elapsed_ms,
  tri.error_message,
  tri.response_text,
  tri.response_payload,
  tri.created_at,
  ti.prompt,
  ti.test_id,
  ti.row_index AS item_row_index,
  t.name AS test_name,
  tr.created_at AS run_created_at,
  ti.prompt_category,
  rc.title AS root_cause_title,
  rc.content AS root_cause_content,
  rc.metadata ->> 'category' AS root_cause_category,
  rc.created_at AS root_cause_generated_at,
  rc.metadata ->> 'rootCause' AS root_cause_reason,
  rc.metadata ->> 'suggestedFix' AS root_cause_suggested_fix
FROM public.test_result_items tri
JOIN public.test_items   ti ON ti.id = tri.test_item_id
JOIN public.test_results tr ON tr.id = tri.test_result_id
JOIN public.tests         t ON  t.id = ti.test_id
LEFT JOIN LATERAL (
  SELECT s.title, s.content, s.metadata, s.created_at
  FROM public.ai_suggestions s
  WHERE s.entity_type = 'test_result_item_failure'
    AND s.entity_id = tri.id::text
  ORDER BY s.sort_order ASC, s.created_at DESC
  LIMIT 1
) rc ON true
WHERE tri.passed = false
ORDER BY tri.test_item_id, tri.created_at DESC;

GRANT SELECT ON public.latest_failed_test_result_items TO authenticated;
GRANT SELECT ON public.latest_failed_test_result_items TO service_role;

DROP FUNCTION IF EXISTS public.admin_latest_failures_count(text);

CREATE OR REPLACE FUNCTION public.admin_latest_failures_count(p_search text)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT count(*)::bigint
  FROM public.latest_failed_test_result_items v
  WHERE trim(coalesce(p_search, '')) = ''
     OR position(lower(trim(p_search)) in lower(v.prompt)) > 0
     OR position(lower(trim(p_search)) in lower(coalesce(v.error_message, ''))) > 0
     OR position(lower(trim(p_search)) in lower(coalesce(v.response_text, ''))) > 0
     OR position(lower(trim(p_search)) in lower(coalesce(v.root_cause_content, ''))) > 0
     OR position(lower(trim(p_search)) in lower(v.test_name)) > 0;
$$;

DROP FUNCTION IF EXISTS public.admin_latest_failures_page(text, integer, integer);

CREATE OR REPLACE FUNCTION public.admin_latest_failures_page(
  p_search text,
  p_limit integer,
  p_offset integer
)
RETURNS SETOF public.latest_failed_test_result_items
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM public.latest_failed_test_result_items v
  WHERE trim(coalesce(p_search, '')) = ''
     OR position(lower(trim(p_search)) in lower(v.prompt)) > 0
     OR position(lower(trim(p_search)) in lower(coalesce(v.error_message, ''))) > 0
     OR position(lower(trim(p_search)) in lower(coalesce(v.response_text, ''))) > 0
     OR position(lower(trim(p_search)) in lower(coalesce(v.root_cause_content, ''))) > 0
     OR position(lower(trim(p_search)) in lower(v.test_name)) > 0
  ORDER BY v.created_at DESC
  LIMIT CASE WHEN p_limit < 1 THEN 25 WHEN p_limit > 100 THEN 100 ELSE p_limit END
  OFFSET greatest(p_offset, 0);
$$;

GRANT EXECUTE ON FUNCTION public.admin_latest_failures_count(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_latest_failures_count(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_latest_failures_page(text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_latest_failures_page(text, integer, integer) TO service_role;

COMMIT;
