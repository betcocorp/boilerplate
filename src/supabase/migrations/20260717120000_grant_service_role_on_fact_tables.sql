-- Fix: the structured-fact tables (B0-185 facts, B0-196 grounding, B0-200 aliases)
-- were created out-of-band and never granted to service_role. The schema-wide
-- `grant ... on all tables in schema rag to service_role` in
-- 20260403121000_create_rag_core_tables.sql is point-in-time; it does not cover
-- tables created afterward. As a result the runtime service_role client got
-- `42501 permission denied` on every read, which fetchProductLineFacts() and
-- resolveProductLineKeyByName() swallow silently — so get_efficacy_data and the
-- "Verified Product Facts" grounding block returned no data even though the rows
-- exist. The app only ever reads these tables (loads happen out-of-band), so
-- SELECT is the least-privilege fix. Idempotent: grants can be re-applied safely.

grant select on rag.product_efficacy   to service_role;
grant select on rag.product_line_fact  to service_role;
grant select on rag.product_alias      to service_role;
