-- Durable web-search response cache (extends WEB-4 / B0-55): so repeated identical queries are
-- served from the DB instead of re-billing the provider. Layered UNDER the in-memory cache.
create table if not exists public.web_search_cache (
  cache_key   text primary key,          -- webSearchCacheKey(provider, normalized request)
  query       text not null,
  provider    text not null,
  response    jsonb not null,            -- full WebSearchResponse (query/provider/answer/results/metrics)
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,      -- TTL (WEBSEARCH_CACHE_TTL_MS from write time)
  hit_count   integer not null default 0
);
create index if not exists web_search_cache_expires_at_idx on public.web_search_cache (expires_at);
-- Locked down: only the service role (bypasses RLS) reads/writes this cache.
alter table public.web_search_cache enable row level security;
