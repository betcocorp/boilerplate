-- B0-200 — product alias/synonym table for deterministic name -> product_line_key resolution.
-- APPLIED to prod 2026-07-15. Seeds only UNAMBIGUOUS aliases (a normalized title / code that
-- maps to exactly one product line) so resolution never anchors to the wrong line.
create table if not exists rag.product_alias (
  id                uuid primary key default gen_random_uuid(),
  alias_norm        text not null,   -- normalized key (lower, ®/™ stripped, whitespace collapsed)
  alias             text not null,   -- original display form
  entity_id         uuid references rag.entity(id) on delete cascade,
  product_line_key  text not null,
  source            text not null default 'seed',   -- seed | title | prod_line_id | manual
  confidence        numeric not null default 1.0,
  created_at        timestamptz not null default timezone('utc', now()),
  unique (alias_norm)
);
create index if not exists product_alias_plk_idx on rag.product_alias (product_line_key);

alter table rag.product_alias enable row level security;
create policy product_alias_service_role on rag.product_alias
  for all to service_role using (true) with check (true);

-- Seed 1: unambiguous normalized titles.
with base as (
  select id, product_line_key, title,
         lower(regexp_replace(regexp_replace(title, '[®™]', '', 'g'), '\s+', ' ', 'g')) as norm
  from rag.entity
  where entity_type = 'product_line'
    and product_line_key is not null
    and coalesce(trim(title), '') <> ''
),
uniq as (
  select norm from base group by norm having count(distinct product_line_key) = 1
)
insert into rag.product_alias (alias_norm, alias, entity_id, product_line_key, source, confidence)
select distinct on (b.norm) trim(b.norm), b.title, b.id, b.product_line_key, 'title', 0.9
from base b
join uniq u on u.norm = b.norm
where trim(b.norm) <> ''
order by b.norm, b.id
on conflict (alias_norm) do nothing;

-- Seed 2: unambiguous prod_line_id codes (e.g. "4020").
with codes as (
  select id, product_line_key, lower(trim(metadata->>'prod_line_id')) as code
  from rag.entity
  where entity_type = 'product_line'
    and product_line_key is not null
    and nullif(trim(metadata->>'prod_line_id'), '') is not null
),
uniqc as (
  select code from codes group by code having count(distinct product_line_key) = 1
)
insert into rag.product_alias (alias_norm, alias, entity_id, product_line_key, source, confidence)
select distinct on (c.code) c.code, c.code, c.id, c.product_line_key, 'prod_line_id', 1.0
from codes c
join uniqc u on u.code = c.code
where c.code <> ''
order by c.code, c.id
on conflict (alias_norm) do nothing;
