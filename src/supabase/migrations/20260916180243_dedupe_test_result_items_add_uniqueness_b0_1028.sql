-- B0-1028: dedupe test_result_items, enforce uniqueness on (test_result_id,
-- test_item_id), and repair the passed_items/failed_items aggregates on the
-- test_results rows that had duplicates (bounded blast radius, verified live:
-- 84 duplicate pairs across 6 test_results rows, max 2 rows per pair).

create table if not exists public._b0_1028_affected_results as
select distinct test_result_id
from (
  select test_result_id, test_item_id, count(*) as n
  from public.test_result_items
  group by test_result_id, test_item_id
  having count(*) > 1
) dupes;

-- Keep the most recently created row per (test_result_id, test_item_id) pair --
-- that reflects the latest execution attempt, matching retry intent.
with ranked as (
  select id,
         row_number() over (
           partition by test_result_id, test_item_id
           order by created_at desc, id desc
         ) as rn
  from public.test_result_items
)
delete from public.test_result_items tri
using ranked r
where tri.id = r.id and r.rn > 1;

alter table public.test_result_items
  add constraint test_result_items_result_item_unique unique (test_result_id, test_item_id);

with counts as (
  select tri.test_result_id,
         count(*) filter (where tri.passed = true) as passed,
         count(*) filter (where tri.passed = false) as failed
  from public.test_result_items tri
  join public._b0_1028_affected_results a on a.test_result_id = tri.test_result_id
  group by tri.test_result_id
)
update public.test_results tr
set passed_items = c.passed, failed_items = c.failed
from counts c
where tr.id = c.test_result_id;

drop table public._b0_1028_affected_results;
