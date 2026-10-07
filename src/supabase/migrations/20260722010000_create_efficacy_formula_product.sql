-- B0-231 — Formula (M000xxx) <-> Betco product/SKU crosswalk.
--
-- Bridges the efficacy lab-report corpus (rag.document / rag.document_chunk with
-- document_kind='efficacy', keyed by formula_code — see B0-223/224/227/228) to the
-- product catalog (rag.entity, keyed by product_line_key / sku / product_key).
-- Many-to-many: one formula can back several products, and a product line may cite
-- several formulas over time (superseded versions stay linked for history).
--
-- Not to be confused with the pre-existing rag.product_efficacy table (structured
-- time-kill claims extracted per-entity from SDS/label text, no formula_code or lab
-- report concept — see B0-185/196). That table is untouched by this migration; once
-- B0-232 backfills this crosswalk it becomes the authoritative, citable source and
-- product_efficacy remains a secondary/fallback grounding source.
create table if not exists rag.efficacy_formula_product (
  id uuid primary key default gen_random_uuid(),
  formula_code text not null,
  product_line_key text,
  sku text,
  registrant_role text not null default 'primary',
  notes text,
  is_active boolean not null default true,
  effective_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint efficacy_formula_product_registrant_role_check
    check (registrant_role in ('primary', 'sub')),
  constraint efficacy_formula_product_has_target
    check (product_line_key is not null or sku is not null)
);

comment on table rag.efficacy_formula_product is
  'B0-231: many-to-many crosswalk from lab-report formula_code to product_line_key/sku. registrant_role distinguishes a sub-registrant (MCA-style contract formula) from the primary EPA registration holder (see B0-234).';

-- One row per (formula, product target, role); coalesce so a NULL product_line_key or
-- NULL sku still participates in the uniqueness check instead of being ignored.
create unique index if not exists efficacy_formula_product_identity_key
  on rag.efficacy_formula_product (
    formula_code,
    coalesce(product_line_key, ''),
    coalesce(sku, ''),
    registrant_role
  );

create index if not exists efficacy_formula_product_formula_idx
  on rag.efficacy_formula_product (formula_code);
create index if not exists efficacy_formula_product_product_line_idx
  on rag.efficacy_formula_product (product_line_key) where product_line_key is not null;
create index if not exists efficacy_formula_product_sku_idx
  on rag.efficacy_formula_product (sku) where sku is not null;

drop trigger if exists set_efficacy_formula_product_updated_at on rag.efficacy_formula_product;
create trigger set_efficacy_formula_product_updated_at
  before update on rag.efficacy_formula_product
  for each row execute function rag.set_updated_at();

grant select, insert, update, delete on rag.efficacy_formula_product to service_role;

alter table rag.efficacy_formula_product enable row level security;
drop policy if exists efficacy_formula_product_service_role on rag.efficacy_formula_product;
create policy efficacy_formula_product_service_role on rag.efficacy_formula_product
  for all to service_role using (true) with check (true);
