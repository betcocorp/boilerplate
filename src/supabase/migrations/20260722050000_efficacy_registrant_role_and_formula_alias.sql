-- B0-234 — Sub-registrant / MCA formula variant support.
--
-- 1) Derive registrant_role + distributor number from the EPA registration number
--    already captured on rag.document (rag.document.epa_registration, populated by the
--    REC-3 extraction work — see 20260713030000_rec_add_product_attribute_columns.sql,
--    which already derives epa_registrant = split_part(epa_registration, '-', 1)).
--    EPA format: "XXXXX-XX" (2 segments = primary registration holder) or
--    "XXXXX-XX-XXXXX" (3 segments = sub-registrant; 3rd segment = distributor number).
alter table rag.document
  add column if not exists epa_registrant_role text generated always as (
    case
      when epa_registration is null then null
      when (length(epa_registration) - length(replace(epa_registration, '-', ''))) = 1 then 'primary'
      when (length(epa_registration) - length(replace(epa_registration, '-', ''))) >= 2 then 'sub'
      else null
    end
  ) stored,
  add column if not exists epa_distributor_number text generated always as (
    case
      when epa_registration is not null
        and (length(epa_registration) - length(replace(epa_registration, '-', ''))) >= 2
        then nullif(split_part(epa_registration, '-', 3), '')
      else null
    end
  ) stored;

comment on column rag.document.epa_registrant_role is
  'B0-234: derived from EPA reg-number segment count — primary (2 segments) vs sub-registrant (3 segments, distributor-specific).';
comment on column rag.document.epa_distributor_number is
  'B0-234: the 3rd EPA reg-number segment for a sub-registrant (distributor) product; null for a primary registration.';

create index if not exists document_epa_registrant_role_idx
  on rag.document (epa_registrant_role) where epa_registrant_role is not null;

-- 2) MCA contract-formula variant <-> base formula lineage (e.g. MCA0795 <-> M000795 per the
-- Master sheet notes referenced in B0-234). Seeded empty — no confirmed mapping exists without
-- the actual Master Efficacy Version Data sheet (B0-223, blocked on source file). This is the
-- mechanism; population is a data task once that sheet is available.
create table if not exists rag.efficacy_formula_alias (
  mca_formula_code text primary key,
  base_formula_code text not null,
  notes text,
  created_at timestamptz not null default timezone('utc', now())
);

comment on table rag.efficacy_formula_alias is
  'B0-234: contract/co-pack (MCA-prefixed) formula code -> base formula_code lineage. Seeded empty pending the Master Efficacy Version Data sheet.';

grant select, insert, update, delete on rag.efficacy_formula_alias to service_role;
alter table rag.efficacy_formula_alias enable row level security;
drop policy if exists efficacy_formula_alias_service_role on rag.efficacy_formula_alias;
create policy efficacy_formula_alias_service_role on rag.efficacy_formula_alias
  for all to service_role using (true) with check (true);
