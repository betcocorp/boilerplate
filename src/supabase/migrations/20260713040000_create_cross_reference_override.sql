create table if not exists public.cross_reference_override (
  id uuid primary key default gen_random_uuid(),
  competitor_brand text not null,
  competitor_product text not null,
  competitor_epa_reg text,
  betco_product_key text,
  betco_product_line_id text,
  betco_title text not null,
  betco_product_url text,
  chemistry_class text,
  rationale text,
  confidence numeric not null default 0.95 check (confidence >= 0 and confidence <= 1),
  is_active boolean not null default true,
  created_by text default 'rec-seed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.cross_reference_override is
  'Curated competitor->Betco cross-reference overrides consulted BEFORE the legacy mapping (REC-3 / B0-76). App-owned (survives legacy MSSQL re-syncs). Service-role only.';
create index if not exists cross_reference_override_lookup_idx
  on public.cross_reference_override (lower(competitor_brand), lower(competitor_product)) where is_active;
alter table public.cross_reference_override enable row level security;
