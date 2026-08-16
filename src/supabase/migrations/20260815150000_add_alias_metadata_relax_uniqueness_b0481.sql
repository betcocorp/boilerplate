-- B0-481: add alias_type/verified/review metadata to rag.product_alias; relax uniqueness so a
-- given alias_norm can legitimately recur across different product lines (e.g. a US vs. Canada
-- variant sharing a display name), which the old bare UNIQUE(alias_norm) forbade outright.
--
-- alias_type backfill mapping (confirmed against the live table's actual distinct `source`
-- values before writing this migration -- the ticket's suggested 'title'/'sku'/'legacy_name'
-- enumeration was directionally right but incomplete; two backfill-era sources needed mapping
-- too):
--   'legacy-product'             (18,626 rows) -> 'sku'         -- legacy SKU/InvtID codes (B0-248)
--   'backfill_sku_20260721'      (   535 rows) -> 'sku'         -- same shape, earlier backfill effort
--   'prod_line_id'               ( 1,703 rows) -> 'legacy_name' -- bare internal numeric line codes (e.g. "028")
--   'title'                      ( 1,282 rows) -> 'title'       -- normalized rag.entity.title text
--   'backfill_line_name_20260721'(   488 rows) -> 'title'       -- same shape (full product-line display names)
-- No live rows use the table's 'seed'/'manual' source defaults today; the alias_type default
-- below ('synonym') only matters for such not-yet-seen sources and for any future manual entry
-- whose alias_type isn't set explicitly by the caller.
alter table rag.product_alias
  add column alias_type text,
  add column verified boolean not null default false,
  add column reviewed_by text,
  add column reviewed_at timestamptz;

update rag.product_alias
set alias_type = case
  when source in ('legacy-product', 'backfill_sku_20260721') then 'sku'
  when source = 'prod_line_id' then 'legacy_name'
  when source in ('title', 'backfill_line_name_20260721') then 'title'
  else 'synonym'
end
where alias_type is null;

alter table rag.product_alias
  alter column alias_type set default 'synonym',
  alter column alias_type set not null;

alter table rag.product_alias
  add constraint product_alias_alias_type_check
  check (alias_type in ('acronym', 'common_name', 'sku', 'misspelling', 'legacy_name', 'synonym', 'title'));

-- All rows seeded so far came from trusted legacy fields (SKU/InvtID, prod_line_id, entity title),
-- not free-text/manual submission, so they're backfilled as verified per the ticket.
update rag.product_alias set verified = true where verified = false;

-- Relax uniqueness: alias_norm alone is no longer guaranteed unique (a name can legitimately
-- resolve to more than one product_line_key, e.g. US/CAN variants) -- the pair is now the real
-- key. Add a plain btree index on alias_norm alone so exact-match lookups (still filtered further
-- in application code, see resolveProductEntityByName in ~/lib/rag/entity-context.ts) don't lose
-- their index once the old unique index backing that column is dropped.
alter table rag.product_alias drop constraint product_alias_alias_norm_key;
create index if not exists product_alias_alias_norm_idx on rag.product_alias (alias_norm);
alter table rag.product_alias
  add constraint product_alias_alias_norm_product_line_key_key unique (alias_norm, product_line_key);

comment on column rag.product_alias.alias_type is
  'B0-481: acronym | common_name | sku | misspelling | legacy_name | synonym | title. Backfilled from the legacy `source` column (see migration header for mapping); default synonym for unclassified/future rows.';
comment on column rag.product_alias.verified is
  'B0-481: true when a human or trusted legacy source has confirmed this alias maps to the correct product_line_key. Existing seeded rows backfilled true.';
comment on column rag.product_alias.reviewed_by is 'B0-481: identifier of the reviewer who last verified/edited this alias, if any.';
comment on column rag.product_alias.reviewed_at is 'B0-481: timestamp of the last human review, if any.';
