-- B0-528: durable escalation records written by the `escalation_specialist` tool (epic B0-525).
--
-- The "real ticket" the bathroom prompt historically asked for is, for now, an INTERNAL record in
-- this table surfaced at /admin/escalations. The outbound HubSpot ticket sync described in
-- src/docs/escalation-agent.md (step 3) is deferred until a HubSpot Private App token exists;
-- `external_ticket_ref` is reserved for that id. See ~/lib/escalations/escalation-repository.ts.

-- Human-readable reference, e.g. ESC-0042: a plain sequence, zero-padded to four digits (grows past
-- four digits naturally), so it is stable, unique and easy to read aloud on a phone call.
CREATE SEQUENCE IF NOT EXISTS public.escalation_reference_seq AS bigint START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS public.escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'open',
  reference text NOT NULL UNIQUE
    DEFAULT ('ESC-' || lpad(nextval('public.escalation_reference_seq')::text, 4, '0')),
  -- Same vocabulary as workflow_runs.source (harness | bex_chat | orchestrator_api); null when the
  -- tool ran without a workflow (e.g. the admin tool runner).
  source text,
  workflow_run_id uuid,
  conversation_id uuid,
  -- B0-1084 convention: user_id is the act-as-aware owner of the conversation, acted_by_user_id the
  -- true session user when an admin was acting-as (else null). Copied from agent_conversations.
  user_id text,
  acted_by_user_id text,
  -- SME agent id that was running when the tool was called (e.g. bathroom, floor_vct).
  specialist text,
  reason text NOT NULL,
  question text NOT NULL,
  summary text NOT NULL,
  retrieved_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Reserved for the deferred HubSpot ticket id.
  external_ticket_ref text,
  resolved_at timestamp with time zone,
  resolution_notes text,
  CONSTRAINT escalations_status_check CHECK (
    status IN ('open', 'in_review', 'resolved', 'dismissed')
  ),
  CONSTRAINT escalations_source_check CHECK (
    source IS NULL OR source IN ('harness', 'bex_chat', 'orchestrator_api')
  ),
  CONSTRAINT escalations_reason_check CHECK (
    reason IN (
      'no_evidence',
      'low_confidence',
      'regulated_value_not_on_file',
      'out_of_scope',
      'compatibility_unverified',
      'safety_incident',
      'user_requested',
      'other'
    )
  )
);

ALTER SEQUENCE public.escalation_reference_seq OWNED BY public.escalations.reference;

COMMENT ON TABLE public.escalations IS
  'B0-528 -- one row per escalation_specialist tool call: a question Bex could not answer from approved documents, logged for the Betco team to follow up. Written by ~/lib/escalations/escalation-tool.ts, listed/updated at /admin/escalations. external_ticket_ref is reserved for the deferred HubSpot sync (src/docs/escalation-agent.md step 3).';
COMMENT ON COLUMN public.escalations.reference IS
  'Human-readable id relayed to the user (ESC-0042). Sequence-backed, unique, never reused.';
COMMENT ON COLUMN public.escalations.reason IS
  'Why Bex escalated, as the model classified it: no_evidence | low_confidence | regulated_value_not_on_file | out_of_scope | compatibility_unverified | safety_incident | user_requested | other.';
COMMENT ON COLUMN public.escalations.retrieved_sources IS
  'Array of {title, documentId?} -- the documents the model had already retrieved when it escalated, so a reviewer can see what was ruled out.';

CREATE INDEX IF NOT EXISTS escalations_status_created_at_idx
  ON public.escalations (status, created_at DESC);
CREATE INDEX IF NOT EXISTS escalations_conversation_id_idx
  ON public.escalations (conversation_id);

-- Same posture as public.test_result_comparisons (20260826210000): RLS on, service_role-only. The
-- app reads and writes exclusively through ~/supabase/clients/service-role.
ALTER TABLE public.escalations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS escalations_service_role ON public.escalations;
CREATE POLICY escalations_service_role ON public.escalations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_escalations_updated_at ON public.escalations;
CREATE TRIGGER trg_escalations_updated_at
  BEFORE UPDATE ON public.escalations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Gate for the tool itself. OFF by default so eval/harness runs do not create rows until it is
-- deliberately enabled on /admin/settings. Read by isEscalationToolEnabled()
-- (~/lib/settings/settings-service.ts): when false the tool is withheld from the model's tool list
-- and the executor returns a structured "disabled" result instead of inserting.
insert into public.settings (key, value, value_type, description, allowed_values, default_value, ui_group) values
  ('BEX_ESCALATION_TOOL_ENABLED', null, 'boolean', 'When true, the escalation_specialist tool is offered to the model on every product-support route and each call writes a durable row to public.escalations (listed at /admin/escalations). When false (default) the tool is not sent to the model, and any stray call returns a "disabled" result without creating a record. Turn on deliberately: eval and harness runs create escalation rows too while this is true.', null, 'false', 'Bex answer pipeline')
on conflict (key) do nothing;
