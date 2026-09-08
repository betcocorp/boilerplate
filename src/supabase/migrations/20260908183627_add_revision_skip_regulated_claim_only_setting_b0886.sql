-- B0-886: settings-table flag gating whether the revision pass is skipped entirely when the
-- FIRST validator pass's issues are already all `regulated_claim_unverified:*` markers. The
-- deterministic regulated-claim redaction planner (`planRegulatedClaimRedaction`) already handles
-- that rejection without an LLM rewrite; running the revision pass on top risks paraphrasing away
-- the exact verbatim citation the redaction step needs to find.
--
-- Default is OFF (false) -- Tom Bird has not yet decided whether this behavior is correct for the
-- epic. NOTE: as of this migration, `run-product-support-workflow.ts` evaluates the regulated-claim
-- guardrail AFTER the revision-pass gate this flag checks, so enabling it is currently a no-op
-- until/unless that ordering changes -- see `isRevisionSkipForRegulatedClaimOnlyEnabled`'s doc
-- comment in `~/lib/workflows/product-support/validator.ts`.

INSERT INTO public.settings (key, value, value_type, description, allowed_values) VALUES
  ('BEX_REVISION_SKIP_REGULATED_CLAIM_ONLY_ENABLED', 'false', 'boolean',
   'Skip the LLM revision pass when the first validator pass''s only issues are regulated_claim_unverified:* (B0-886: off by default, pending Tom''s decision on the epic)', NULL)
ON CONFLICT (key) DO NOTHING;
