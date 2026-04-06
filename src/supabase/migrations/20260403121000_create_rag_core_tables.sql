create or replace function rag.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists rag.source_record (
  id uuid primary key default gen_random_uuid(),
  source_schema text not null,
  source_table text not null,
  source_pk text not null,
  source_locale text not null default 'und',
  source_type text not null,
  source_uri text,
  checksum text,
  is_active boolean not null default true,
  last_seen_at timestamptz not null default timezone('utc', now()),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint source_record_identity_key unique (
    source_schema,
    source_table,
    source_pk,
    source_locale
  )
);

create table if not exists rag.entity (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  canonical_key text not null,
  title text,
  sku text,
  product_key text,
  product_line_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint entity_identity_key unique (entity_type, canonical_key)
);

create table if not exists rag.entity_link (
  from_entity_id uuid not null references rag.entity (id) on delete cascade,
  to_entity_id uuid not null references rag.entity (id) on delete cascade,
  relation_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (from_entity_id, to_entity_id, relation_type)
);

create table if not exists rag.document (
  id uuid primary key default gen_random_uuid(),
  document_key text not null unique,
  source_record_id uuid not null references rag.source_record (id) on delete cascade,
  entity_id uuid references rag.entity (id) on delete set null,
  document_kind text not null,
  title text not null,
  language_code text not null default 'und',
  body_text text not null,
  body_markdown text,
  summary text,
  token_count integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists rag.document_chunk (
  id uuid primary key default gen_random_uuid(),
  chunk_key text not null unique,
  document_id uuid not null references rag.document (id) on delete cascade,
  chunk_index integer not null,
  section_path text[] not null default '{}'::text[],
  heading text,
  chunk_text text not null,
  token_count integer,
  embedding_model text,
  embedding extensions.vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  search_vector tsvector generated always as (
    to_tsvector('english', coalesce(heading, '') || ' ' || coalesce(chunk_text, ''))
  ) stored,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint document_chunk_order_key unique (document_id, chunk_index)
);

create index if not exists source_record_source_type_idx
  on rag.source_record (source_type);

create index if not exists source_record_active_idx
  on rag.source_record (is_active);

create index if not exists entity_type_key_idx
  on rag.entity (entity_type, canonical_key);

create index if not exists entity_product_key_idx
  on rag.entity (product_key);

create index if not exists entity_product_line_key_idx
  on rag.entity (product_line_key);

create index if not exists entity_link_relation_idx
  on rag.entity_link (relation_type);

create index if not exists document_source_record_idx
  on rag.document (source_record_id);

create index if not exists document_entity_idx
  on rag.document (entity_id);

create index if not exists document_kind_language_idx
  on rag.document (document_kind, language_code);

create index if not exists document_metadata_gin_idx
  on rag.document using gin (metadata);

create index if not exists document_chunk_document_idx
  on rag.document_chunk (document_id);

create index if not exists document_chunk_search_vector_idx
  on rag.document_chunk using gin (search_vector);

create index if not exists document_chunk_metadata_gin_idx
  on rag.document_chunk using gin (metadata);

create index if not exists document_chunk_embedding_hnsw_idx
  on rag.document_chunk
  using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null;

create trigger set_source_record_updated_at
before update on rag.source_record
for each row
execute function rag.set_updated_at();

create trigger set_entity_updated_at
before update on rag.entity
for each row
execute function rag.set_updated_at();

create trigger set_document_updated_at
before update on rag.document
for each row
execute function rag.set_updated_at();

create trigger set_document_chunk_updated_at
before update on rag.document_chunk
for each row
execute function rag.set_updated_at();

grant select, insert, update, delete on all tables in schema rag to service_role;

comment on table rag.source_record is
  'Tracks each upstream legacy record or file that feeds the derived retrieval corpus.';

comment on table rag.entity is
  'Canonical business entities used for metadata filtering and graph traversal.';

comment on table rag.document is
  'Retrieval-ready documents derived from source records and linked to entities.';

comment on table rag.document_chunk is
  'Chunked sections of retrieval documents with lexical and vector search indexes.';
