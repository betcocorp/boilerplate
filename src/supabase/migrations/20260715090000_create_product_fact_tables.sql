-- B0-193 — Structured-fact tables (product_line_fact, product_efficacy)
-- Design: src/docs/BEX-2.0-Structured-Fact-Join-Design.md §4
-- Typed, cited, product-line-grained facts keyed on rag.entity(id). Facts are joined
-- deterministically at retrieval time — never embedded.

-- ---------------------------------------------------------------------------
-- Scalar attributes, ~1 row per product line. product_key nullable so a future
-- SKU/variant can override the line-level default without a product-tier entity.
-- ---------------------------------------------------------------------------
create table if not exists rag.product_line_fact (
  id                    uuid primary key default gen_random_uuid(),
  entity_id             uuid not null references rag.entity(id) on delete cascade,
  product_key           text,                     -- null = line-level; set = SKU-level override
  dilution_oz_per_gal   numeric,                  -- computed from the 1:N ratio (128 / N); null when RTU/unknown
  dilution_display      text,                     -- human string preserved for citation (e.g. "1:64", "RTU / not diluted")
  coverage_sq_ft        numeric,
  chemistry_class       text,                     -- quat | peroxide | hypochlorite | phenolic | alcohol | acid | other
  product_application   text,                     -- disinfectant | degreaser | floor-finish | ...
  epa_registration      text,
  contact_time_seconds  integer,
  source_record_id      uuid references rag.source_record(id),
  confidence            numeric not null default 1.0,
  updated_at            timestamptz not null default timezone('utc', now())
);

comment on column rag.product_line_fact.dilution_oz_per_gal is
  'Use-dilution in fl oz per US gallon, computed as 128 / N from the legacy 1:N dilution_code. Null when the code is 0 (ready-to-use / not diluted) or unknown. The 1:N interpretation follows rag-specification.md §2.3; unusual denominators should be SME-spot-checked.';
comment on column rag.product_line_fact.dilution_display is
  'Verbatim, citation-safe dilution string ("1:64", "RTU / not diluted"). Source of truth for display; the numeric column is derived.';

-- Line-level rows are unique per entity; SKU-level rows unique per (entity, product_key).
create unique index if not exists product_line_fact_line_uniq
  on rag.product_line_fact (entity_id) where product_key is null;
create unique index if not exists product_line_fact_variant_uniq
  on rag.product_line_fact (entity_id, product_key) where product_key is not null;

-- ---------------------------------------------------------------------------
-- Efficacy matrix: many rows per line (organism/claim × conditions).
-- Populated from the Betco Disinfectant Claims matrix (B0-199, blocked on source docs).
-- ---------------------------------------------------------------------------
create table if not exists rag.product_efficacy (
  id                    uuid primary key default gen_random_uuid(),
  entity_id             uuid not null references rag.entity(id) on delete cascade,
  product_key           text,
  organism              text not null,            -- "Norovirus", "SARS-CoV-2", "Influenza A", ...
  claim_type            text,                     -- disinfect | sanitize | virucide | fungicide | tuberculocide
  dilution_oz_per_gal   numeric,
  contact_time_seconds  integer,
  epa_registration      text,
  source_record_id      uuid references rag.source_record(id),
  source_page           integer,
  confidence            numeric not null default 1.0,
  updated_at            timestamptz not null default timezone('utc', now())
);

create index if not exists product_line_fact_entity_idx on rag.product_line_fact (entity_id);
create index if not exists product_efficacy_entity_idx   on rag.product_efficacy (entity_id);
create index if not exists product_efficacy_organism_idx  on rag.product_efficacy (lower(organism));

-- Born secure: enable RLS with a service-role policy (server paths use the service role,
-- which bypasses RLS anyway; this makes the intent explicit and keeps anon/authenticated out).
alter table rag.product_line_fact enable row level security;
alter table rag.product_efficacy  enable row level security;

create policy product_line_fact_service_role on rag.product_line_fact
  for all to service_role using (true) with check (true);
create policy product_efficacy_service_role on rag.product_efficacy
  for all to service_role using (true) with check (true);
