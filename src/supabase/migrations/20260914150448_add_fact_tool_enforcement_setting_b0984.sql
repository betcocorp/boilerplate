-- B0-984 — BEX_FACT_TOOL_ENFORCEMENT_ENABLED: settings-table switch for the B0-948 fact-tool
-- enforcement step in the product-support workflow.
--
-- B0-948 checks the model's first finished draft for regulated fact categories (efficacy, contact
-- time, dilution, compatibility, hazard, first aid, storage, EPA/DIN) whose owning tool was never
-- called this turn, forces that ONE tool call, and re-drafts. On the 2026-09-13/14 golden runs the
-- re-draft rewrote finished answers against empty or wrong tool results ("The allowed surfaces for
-- 3M Game Line Tape are not on file…", a "yes" answer that never said yes, a four-product HIV-1 list
-- compressed into one redacted sentence); enforced items failed roughly 4x as often as
-- non-enforced ones.
--
-- Seeded OFF: the step is disabled until the additive re-draft (same ticket) is validated on a
-- golden sweep; flip to true in /admin/settings to re-enable with no deploy. Read once per turn by
-- `isFactToolEnforcementEnabled` (~/lib/workflows/product-support/fact-tool-enforcement.ts); the
-- value the turn observed is recorded on `runtimeConfig.factToolEnforcementEnabled` and the
-- `fact_tool_enforcement` gate reads `skipped / disabled_by_flag` when off.
insert into public.settings (key, value, value_type, description, allowed_values) values
  (
    'BEX_FACT_TOOL_ENFORCEMENT_ENABLED',
    'false',
    'boolean',
    'Enable the B0-948 fact-tool enforcement step: after the model''s first finished draft, force the one fact tool (get_efficacy_data, list_allowed_surfaces, get_safety_constraints, get_product_spec) that owns a regulated claim the draft makes but never looked up, then let the model add the returned value to its draft. OFF by default since B0-984: the forced re-draft was rewriting finished answers against empty or wrong tool results and enforced golden items failed about 4x as often as non-enforced ones. Off restores pre-B0-948 behaviour exactly (neither generation runtime receives the check). Takes effect on the next turn, no deploy.',
    null
  )
on conflict (key) do nothing;
