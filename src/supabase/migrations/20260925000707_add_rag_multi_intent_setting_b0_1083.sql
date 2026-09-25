-- Deep-dive "System query expansion" phase 2 (2026-09-24): expandQueryIntents/useMultiIntent
-- existed only in admin/eval tooling, never reachable from live chat. Wiring it into
-- runProductKnowledgeQuery's primary content searches behind this settings row, default off so
-- flipping it on is a deliberate, observable decision rather than a silent behavior change on deploy.

insert into public.settings (key, value, value_type, description, allowed_values, default_value, ui_group) values
  ('RAG_MULTI_INTENT_ENABLED', null, 'boolean', 'Default useMultiIntent for the primary product-knowledge retrieval passes in runProductKnowledgeQuery (compound-question splitting via expandQueryIntents). Previously only reachable from the admin RAG test page and the eval-run executor, never live chat.', null, 'false', 'Retrieval')
on conflict (key) do nothing;
