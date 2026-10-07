-- B0-734: the pre-model early-decline gate (`classifyEarlyDecline` in
-- run-product-support-workflow.ts) becomes a `settings` row, per the B0-638 rule that feature
-- flags live in this table and env is reserved for secrets. It replaces the
-- BEX_EARLY_DECLINE_GATE_ENABLED env var, which defaulted ON.
--
-- Default is OFF. On the three below-B golden-set runs analysed for B0-734 the gate produced 15 of
-- 239 answers with no model call (mean score 48.5/100); its four canned replies contradict the
-- golden datasets on every class they cover, and because it runs before any model call it also
-- stopped the B0-727 shelf-life policy and the B0-559/B0-660 clarifying-question rules from ever
-- applying. Flip to 'true' from /admin/settings to restore the pre-B0-734 behaviour.

INSERT INTO public.settings (key, value, value_type, description, allowed_values) VALUES
  ('BEX_EARLY_DECLINE_GATE_ENABLED', 'false', 'boolean',
   'Answer chemical-mixing, compliance, shelf-life and context-free recommendation asks with a canned decline before any model call (B0-734: off by default; the specialist prompts now carry a policy for each class)', NULL)
ON CONFLICT (key) DO NOTHING;
