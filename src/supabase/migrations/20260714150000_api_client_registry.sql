-- ============================================================
-- 20260714150000_api_client_registry.sql
--
-- Per-client API access for /api/v1/*, modeled as a hierarchy:
--
--   api_project  (consuming product, e.g. "C360")
--     └─ api_app (runtime surface, e.g. "Web")
--          └─ api_key (many labeled tokens per app; hashed at rest)
--
--   api_request_log — one row per authenticated /api/v1/* request,
--   attribution denormalized (key/app/project) for fast rollups.
--
-- All four tables are service-role-only: RLS is enabled with NO
-- policies, so the anon/authenticated PostgREST roles get nothing
-- while the server's service-role client (which bypasses RLS)
-- retains full access.
--
-- Design doc:
--   https://betco.atlassian.net/wiki/spaces/Bex/pages/186122241/API+Security
-- ============================================================


-- ── 1. Project ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.api_project (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  description   text NULL,
  contact_email text NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);


-- ── 2. App ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.api_app (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES public.api_project (id) ON DELETE CASCADE,
  name                  text NOT NULL,
  is_active             boolean NOT NULL DEFAULT true,
  rate_limit_per_minute integer NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_app_rate_limit_positive
    CHECK (rate_limit_per_minute IS NULL OR rate_limit_per_minute > 0),
  CONSTRAINT api_app_name_unique_per_project UNIQUE (project_id, name)
);

CREATE INDEX IF NOT EXISTS api_app_project_id_idx
  ON public.api_app (project_id);


-- ── 3. Key (token) ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.api_key (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id       uuid NOT NULL REFERENCES public.api_app (id) ON DELETE CASCADE,
  label        text NULL,
  token_hash   text NOT NULL,
  prefix       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NULL,
  expires_at   timestamptz NULL,
  revoked_at   timestamptz NULL,
  CONSTRAINT api_key_token_hash_unique UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS api_key_app_id_idx
  ON public.api_key (app_id);


-- ── 4. Request log ───────────────────────────────────────────────────────
-- Attribution refs are nullable + ON DELETE SET NULL so historical log rows
-- survive hard deletion of a key/app/project (we normally revoke, not delete,
-- but analytics must not lose history either way).

CREATE TABLE IF NOT EXISTS public.api_request_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id            uuid NULL REFERENCES public.api_key (id) ON DELETE SET NULL,
  app_id            uuid NULL REFERENCES public.api_app (id) ON DELETE SET NULL,
  project_id        uuid NULL REFERENCES public.api_project (id) ON DELETE SET NULL,
  path              text NOT NULL,
  method            text NOT NULL,
  status            integer NOT NULL,
  latency_ms        integer NULL,
  prompt_tokens     integer NULL,
  completion_tokens integer NULL,
  total_tokens      integer NULL,
  error             text NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Rate-limit window count + per-app dashboard rollups.
CREATE INDEX IF NOT EXISTS api_request_log_app_id_created_at_idx
  ON public.api_request_log (app_id, created_at DESC);

-- Per-project dashboard rollups.
CREATE INDEX IF NOT EXISTS api_request_log_project_id_created_at_idx
  ON public.api_request_log (project_id, created_at DESC);

-- Per-token drill-down.
CREATE INDEX IF NOT EXISTS api_request_log_key_id_created_at_idx
  ON public.api_request_log (key_id, created_at DESC);


-- ── 5. Lock down: RLS on, no policies (service-role only) ─────────────────

ALTER TABLE public.api_project     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_app         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_key         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_request_log ENABLE ROW LEVEL SECURITY;
