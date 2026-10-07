-- B0-483: conflict-detection view for aliases spanning multiple product lines.
--
-- B0-481 relaxed rag.product_alias's uniqueness from bare UNIQUE(alias_norm) to
-- UNIQUE(alias_norm, product_line_key), which legitimately permits the same alias_norm to map to
-- more than one product_line_key (e.g. a US/Canada variant sharing a display name). This view
-- surfaces every such case for human triage, including B0-481's alias_type/verified/reviewed_*
-- columns since those are exactly what a reviewer needs to pick a winner.
--
-- Expected to return 0 rows today: B0-481 only just relaxed the constraint moments ago and no
-- enrichment/seeding work introducing a genuine duplicate alias_norm across product lines has run
-- yet -- confirmed via execute_sql immediately after creating this view (see B0-483 report).

create or replace view rag.product_alias_conflicts as
select
  pa.alias_norm,
  pa.alias,
  pa.product_line_key,
  pa.entity_id,
  pa.source,
  pa.confidence,
  pa.alias_type,
  pa.verified,
  pa.reviewed_by,
  pa.reviewed_at,
  pa.created_at
from rag.product_alias pa
where pa.alias_norm in (
  select alias_norm
  from rag.product_alias
  group by alias_norm
  having count(distinct product_line_key) > 1
)
order by pa.alias_norm, pa.product_line_key;

comment on view rag.product_alias_conflicts is
  'B0-483: every alias_norm with more than one distinct product_line_key (permitted since B0-481 relaxed the unique constraint to (alias_norm, product_line_key)). Empty is the healthy state; non-empty rows need human triage -- see verified/reviewed_* for existing review status.';

-- Same access posture as the underlying table (RLS-restricted to service_role only, see
-- 20260715093000_create_product_alias.sql) -- explicit grant since views do not inherit RLS
-- policies, only the querying role's own privileges.
revoke all on rag.product_alias_conflicts from public, anon, authenticated;
grant select on rag.product_alias_conflicts to service_role;
