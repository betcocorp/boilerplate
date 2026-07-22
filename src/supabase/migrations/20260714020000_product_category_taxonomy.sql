-- B0-33/B0-34 — Product category taxonomy (v1: derived from legacy.prod_line.MetaKeyWords) + links.
create table if not exists public.product_category (
  key text primary key,
  name text not null,
  parent_key text,
  path text[] not null default '{}',
  aliases text[] not null default '{}',
  source text not null default 'metakeywords',
  source_value text,
  depth integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists product_category_parent_idx on public.product_category(parent_key);
alter table public.product_category enable row level security;

create table if not exists public.product_category_link (
  category_key text not null,
  prod_line_key text not null,
  prod_line_id text,
  source text not null default 'metakeywords',
  confidence numeric not null default 0.9,
  created_at timestamptz not null default now(),
  primary key (category_key, prod_line_key)
);
create index if not exists product_category_link_category_idx on public.product_category_link(category_key);
alter table public.product_category_link enable row level security;
