-- B0-498: per-item intended SME agent tag (companion to tests.intended_agent, which is
-- suite-level). Lets a single test set carry a mix of intents, and gives the B0-497 intent
-- classifier eval work (B0-501/B0-503/B0-504) a per-prompt ground-truth label to score against.
alter table public.test_items
  add column intended_agent_item text null;

comment on column public.test_items.intended_agent_item is
  'Per-item ground-truth SME agent id (matches V1_AGENT_REGISTRY ids: product, bathroom, dilution, floor, recommendations) for intent-classifier evaluation (B0-497/B0-498). Null if unlabeled. Distinct from tests.intended_agent, which tags an entire suite.';
