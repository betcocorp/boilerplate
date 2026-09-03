-- B0-746: the single `floor` SME agent was split into four substrate specialists
-- (floor_wood_sport, floor_concrete, floor_stg, floor_vct). `expected_agent`/`predicted_agent`
-- on the routing-test tables duplicate SME_AGENT_IDS (src/lib/agents/agent-registry.ts) in a
-- Postgres CHECK constraint, per the KEEP IN SYNC note on 20260825130000_create_routing_test_items_b0657.sql
-- and its 20260825150000/20260827010400 follow-ups.
--
-- Existing rows: any `expected_agent = 'floor'` row is reclassified to 'floor_vct' as a
-- best-effort default (VCT/resilient-tile was the flagship content the flat `floor` prompt
-- carried) — NOT a claim that every such item is actually a VCT question. A human should re-triage
-- these items against the real substrate named in their prompt text where precision matters.

-- Drop both constraints FIRST: the old constraint's allowed set does not include 'floor_vct', so
-- reclassifying rows below while it's still active would itself violate it. No constraint gap risk
-- here — this migration runs in one transaction, so the table is never visible to another
-- transaction without a CHECK constraint in force.
alter table public.routing_test_items
  drop constraint if exists routing_test_items_expected_agent_check;

alter table public.routing_test_run_items
  drop constraint if exists routing_test_run_items_expected_agent_check;

update public.routing_test_items
  set expected_agent = 'floor_vct'
  where expected_agent = 'floor';

-- routing_test_run_items is historical per-run snapshot data (B0-667) — reclassify the same way so
-- the constraint below does not reject rows already on disk.
update public.routing_test_run_items
  set expected_agent = 'floor_vct'
  where expected_agent = 'floor';

update public.routing_test_run_items
  set predicted_agent = 'floor_vct'
  where predicted_agent = 'floor';

alter table public.routing_test_items
  add constraint routing_test_items_expected_agent_check check (
    expected_agent in (
      'product', 'bathroom', 'dilution',
      'floor_wood_sport', 'floor_concrete', 'floor_stg', 'floor_vct',
      'recommendations', 'cross_reference'
    )
  );

alter table public.routing_test_run_items
  add constraint routing_test_run_items_expected_agent_check check (
    expected_agent = any (array[
      'product'::text, 'bathroom'::text, 'dilution'::text,
      'floor_wood_sport'::text, 'floor_concrete'::text, 'floor_stg'::text, 'floor_vct'::text,
      'recommendations'::text, 'cross_reference'::text
    ])
  );
