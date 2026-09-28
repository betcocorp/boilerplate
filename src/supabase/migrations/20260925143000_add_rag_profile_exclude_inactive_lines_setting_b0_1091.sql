-- B0-1091: settings row that gates whether rag.legacy_product_line_profile_source emits product
-- lines with no active item (metadata.line_lifecycle in ('inactive', 'empty')).
--
-- Read by the view itself (scalar subquery, coalesced to true when the row is missing), so it
-- takes effect on the next rag.sync_legacy_product_profiles() run -- no deploy needed. Value
-- semantics follow resolveSettingValue (~/lib/settings/settings-service.ts): `value` when set,
-- else `default_value`. Same insert pattern as 20260925000707 (B0-1083).

insert into public.settings (key, value, value_type, description, allowed_values, default_value, ui_group) values
  ('RAG_PROFILE_EXCLUDE_INACTIVE_LINES', null, 'boolean', 'When true (default), rag.legacy_product_line_profile_source omits product lines whose metadata.line_lifecycle is ''inactive'' (items exist but none has Status=AC) or ''empty'' (no items linked via legacy.products_attr). The next Products profile sync then deactivates their rag.source_record rows and the chunk sync removes their chunks, so they drop out of retrieval. Set to false and re-run the sync to bring them back (rows are reactivated and re-chunked; nothing is ever deleted from rag.document or rag.entity). Lines with at least one Status=AC item (web_active / active_offline) are always emitted.', null, 'true', 'Retrieval')
on conflict (key) do nothing;
