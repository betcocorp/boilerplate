-- B0-993 — a prompt can refer to more than one product, so the golden dataset's expected
-- canonical product becomes a list.
--
-- `expected_canonical_product text` -> `expected_canonical_products text[] not null default '{}'`.
-- Live data at migration time: 11 of 1,051 rows populated, none containing a delimiter, so the
-- conversion is a plain one-element wrap — no splitting, no archiving needed. Values are
-- `legacy.prod_line.ProdLineKey` strings (or free text on older rows) and pass through verbatim.
--
-- Rename first so scripts/check-schema-drift.mjs retires the old column name rather than
-- reporting it as unapplied, then retype in place with a USING clause.

alter table public.test_items
  rename column expected_canonical_product to expected_canonical_products;

alter table public.test_items
  alter column expected_canonical_products type text[]
  using case
    when nullif(btrim(expected_canonical_products), '') is null then '{}'::text[]
    else array[btrim(expected_canonical_products)]
  end;

update public.test_items set expected_canonical_products = '{}' where expected_canonical_products is null;

alter table public.test_items
  alter column expected_canonical_products set default '{}',
  alter column expected_canonical_products set not null;

comment on column public.test_items.expected_canonical_products is
  'B0-993 — product lines (legacy.prod_line.ProdLineKey) the prompt is about; one element per product. A search-eval item passes only when every listed product line has a retrieval match. Empty = unconstrained.';
