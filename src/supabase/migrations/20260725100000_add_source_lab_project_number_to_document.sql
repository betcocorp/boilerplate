-- B0-238: Add source_lab and project_number columns to rag.document table
-- These columns surface lab and project identifiers from efficacy documents for regulatory citations

alter table rag.document
  add column if not exists source_lab text,
  add column if not exists project_number text;

comment on column rag.document.source_lab is
  'Third-party lab name (e.g., "ABC Testing Lab"), extracted from efficacy document metadata. B0-238.';

comment on column rag.document.project_number is
  'Lab project identifier (e.g., "P-2024-001"), extracted from efficacy document metadata. B0-238.';

create index if not exists document_source_lab_idx on rag.document (source_lab);
create index if not exists document_project_number_idx on rag.document (project_number);
