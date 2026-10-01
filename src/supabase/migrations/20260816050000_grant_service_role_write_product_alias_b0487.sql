-- B0-487 QA fix: rag.product_alias was created (20260715093000_create_product_alias.sql) with an
-- RLS policy granting service_role ALL, but the table-level GRANT was never issued beyond the
-- implicit SELECT every sibling rag table also has -- Postgres checks table-level grants before
-- RLS, so every service-role write (INSERT/UPDATE/DELETE) has been failing with
-- "permission denied for table product_alias" since the table was created. Confirmed live: sibling
-- tables (rag.entity, rag.document, rag.document_chunk) all already have full
-- INSERT/UPDATE/DELETE/SELECT grants to service_role; only product_alias was missing them.
-- Found via live QA of B0-487's approve/edit/reject actions (all three fail without this).
grant insert, update, delete on rag.product_alias to service_role;
