create schema if not exists extensions;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;

create schema if not exists rag;

comment on schema rag is
  'Purpose-built retrieval schema for derived RAG entities, documents, and chunks sourced from legacy catalog data.';

revoke all on schema rag from public;
grant usage on schema rag to service_role;
