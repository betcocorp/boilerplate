-- B0-82 — durable, many-to-many web-search-grounded cross-reference recommendation store.
-- One recommendation (a competitor product) -> many ranked Betco candidates.

create table if not exists rag.cross_reference_recommendations (
  id uuid primary key default gen_random_uuid(),
  competitor_brand text,
  competitor_product text not null,
  normalized_input jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'answered', 'declined', 'verified', 'rejected')),
  overall_confidence numeric,
  threshold_used numeric,
  answer_given boolean not null default false,
  decline_reason text,
  evidence jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists rag.cross_reference_recommendation_candidates (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null
    references rag.cross_reference_recommendations (id) on delete cascade,
  betco_product_key text,
  betco_prod_id text,
  betco_title text,
  candidate_confidence numeric,
  rank integer,
  rationale text,
  source jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_xref_rec_status
  on rag.cross_reference_recommendations (status);
create index if not exists idx_xref_rec_overall_confidence
  on rag.cross_reference_recommendations (overall_confidence);
create index if not exists idx_xref_rec_created_at
  on rag.cross_reference_recommendations (created_at);
create index if not exists idx_xref_rec_candidates_recommendation_id
  on rag.cross_reference_recommendation_candidates (recommendation_id);

-- Service-role only (repository uses the service-role client); anon/authenticated cannot touch it.
alter table rag.cross_reference_recommendations enable row level security;
alter table rag.cross_reference_recommendation_candidates enable row level security;

-- service_role bypasses RLS but still needs table privileges (not auto-granted for tables
-- created outside the normal Supabase flow).
grant select, insert, update, delete on rag.cross_reference_recommendations to service_role;
grant select, insert, update, delete on rag.cross_reference_recommendation_candidates to service_role;
