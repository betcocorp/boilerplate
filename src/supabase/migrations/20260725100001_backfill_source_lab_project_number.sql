-- B0-238: Backfill source_lab and project_number from metadata
-- Extract lab and project identifiers from existing metadata for efficacy documents

update rag.document
set
  source_lab = (
    -- Try 'third_party_lab' first, then 'lab' key
    coalesce(
      metadata->>'third_party_lab',
      metadata->>'lab'
    )
  ),
  project_number = metadata->>'project_number'
where
  document_kind = 'efficacy'
  and (
    metadata ? 'third_party_lab'
    or metadata ? 'lab'
    or metadata ? 'project_number'
  );

-- Log backfill result
do $$
declare
  v_updated_count integer;
begin
  select count(*) into v_updated_count
  from rag.document
  where document_kind = 'efficacy' and (source_lab is not null or project_number is not null);

  raise notice 'B0-238 backfill complete: % documents updated', v_updated_count;
end $$;
