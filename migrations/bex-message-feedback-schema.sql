-- Message-level feedback storage for BEX assistant responses
-- Run this in Supabase SQL editor (or your migration pipeline).

BEGIN;

CREATE TABLE IF NOT EXISTS public.agent_message_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.agent_messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.agent_conversations(id) ON DELETE CASCADE,
  workflow_run_id uuid REFERENCES public.workflow_runs(id) ON DELETE SET NULL,
  rating text NOT NULL CHECK (rating IN ('up', 'down')),
  reason_code text,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_message_feedback_message_id_unique
  ON public.agent_message_feedback (message_id);

CREATE INDEX IF NOT EXISTS idx_agent_message_feedback_conversation_id
  ON public.agent_message_feedback (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_message_feedback_workflow_run_id
  ON public.agent_message_feedback (workflow_run_id);

CREATE OR REPLACE FUNCTION public.set_agent_message_feedback_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agent_message_feedback_updated_at
  ON public.agent_message_feedback;

CREATE TRIGGER trg_agent_message_feedback_updated_at
BEFORE UPDATE ON public.agent_message_feedback
FOR EACH ROW
EXECUTE FUNCTION public.set_agent_message_feedback_updated_at();

COMMIT;
