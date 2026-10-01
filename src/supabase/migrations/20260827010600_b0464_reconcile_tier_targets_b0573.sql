-- B0-464 RECONCILIATION BACKFILL — DDL applied live with no checked-in migration file.
-- Transcribed from the live catalog on 2026-08-27, not from memory.
--
-- `public.tier_targets` (B0-573) exists live — the live supabase_migrations ledger carries a row
-- named `create_tier_targets_b0573` — but no migration file was ever committed, so
-- scripts/check-schema-drift.mjs reported `rel-missing`.
--
-- The three seed rows are reference data the golden-set verdict depends on, so they are seeded here
-- too (on conflict do nothing — an operator's later edits from /admin/tests are preserved).
--
-- Every statement below is a NO-OP against the current live database.

create table if not exists public.tier_targets (
  tier smallint primary key,
  target_pass_rate numeric(4, 3) not null,
  is_gate boolean not null default false,
  label text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tier_targets_tier_check check (tier >= 1 and tier <= 3),
  constraint tier_targets_target_pass_rate_check
    check (target_pass_rate >= 0::numeric and target_pass_rate <= 1::numeric)
);

alter table public.tier_targets enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'tier_targets'
      and policyname = 'tier_targets_service_role'
  ) then
    create policy tier_targets_service_role on public.tier_targets
      for all to service_role using (true) with check (true);
  end if;
end $$;

-- Live values as of 2026-08-27. Transcribed exactly; do not round target_pass_rate.
insert into public.tier_targets (tier, target_pass_rate, is_gate, label)
values
  (1, 1.000, true,  'Critical'),
  (2, 0.800, false, 'Core'),
  (3, 0.000, false, 'Exploratory')
on conflict (tier) do nothing;

comment on table public.tier_targets is
  'B0-573: per-tier pass-rate targets and gate semantics for the golden-set verdict. Edited from /admin/tests; changes audited in audit_logs with old + new values.';
