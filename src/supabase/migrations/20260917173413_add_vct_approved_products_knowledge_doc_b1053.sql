-- B0-1053 — VCT "what stripping and finish products should I use?" retrieval gap.
--
-- Root cause (confirmed live via Supabase MCP cosine-similarity re-ranking against the real
-- production query embedding, rag.search_embedding.id = 16585, query "what stripping and finish
-- products should I use for my VCT floor?"): NOTHING in the top 30 corpus chunks by cosine
-- similarity names the actual Betco VCT stripper/finish product lineup. The nearest topical
-- document, "VCT Finish Selection", never names a single product (it's a maintenance-capacity
-- framework); "VCT Green Certified" only names the unrelated Green Earth line; the one document
-- that does name a real product ("Betco Cleaning Solutions Guide", "Extreme(R)") ranks #27,
-- outside the ~20-candidate retrieval window. Denied a real citation, the model fabricated
-- product names/dilution ratios, which regulatedClaimGuardrail correctly caught and redacted —
-- that guardrail behavior is correct and is NOT touched here.
--
-- Fix direction chosen: content (ticket option 2), not retrieval/query-rewrite (option 1) — see
-- the B0-1053 implementation report for the full justification. This adds one purpose-built
-- knowledge chunk that enumerates the real product lineup by name, closely mirroring the golden
-- query's own phrasing, so this class of question has an on-topic, high-similarity retrieval
-- target instead of depending on the maintenance-framework doc or scattered single-product labels
-- to rank into the window.
--
-- Every product name below was confirmed live against rag.entity / rag.document (Supabase MCP,
-- 2026-09-17) before being written here — none is guessed, and none is a bare paraphrase of the
-- ticket text. Two corrections from the ticket's own wording, both verified against real
-- entity/label titles: "Finish101" -> "Finish 101" (one word in the ticket, two in the corpus),
-- and "High-Tech" -> "Hi-Tech" (the ticket's paraphrase; the real ingested label is titled
-- "Hi-Tech"). No dilution ratio, EPA registration number, or other regulated numeric value is
-- transcribed here — per the regulated-data rule, this chunk names products by brand only and
-- explicitly defers exact specs to each product's own label, which is also literally how the
-- golden item's own ideal_response is worded ("exact dilutions and specs come from each
-- product's label").
--
-- source_type is 'manual_markdown' (not the pipeline's 's3_markdown') so this row is honestly
-- distinguishable from a real S3-backed knowledge upload: it is NOT discovered or managed by the
-- admin Knowledge Ingestion dashboard (src/app/(authenticated)/admin/knowledge), and a future
-- re-ingestion sweep of the real S3 corpus will not touch or duplicate it. metadata.s3_key is a
-- synthetic path only, kept in the same "v1-markdown-files/vct/..." shape so
-- deriveKnowledgeCategoryFromS3Key (~/lib/rag/search.ts) still resolves this document's category
-- to "vct" for the B0-780 specialist category-scoping filter.
--
-- embedding_large is intentionally left NULL by this migration — SQL cannot call the OpenAI
-- embeddings API. It is populated immediately after this migration is applied by calling the real
-- ~/lib/rag/embeddings.ts sync path (text-embedding-3-large, halfvec(3072)), matching how every
-- other chunk in the corpus is embedded.

with new_source as (
  insert into rag.source_record
    (source_schema, source_table, source_type, source_pk, source_locale, source_uri, is_active, metadata, last_seen_at)
  values (
    'knowledge',
    'file',
    'manual_markdown',
    'b0-1053-vct-approved-products',
    'EN',
    null,
    true,
    jsonb_build_object(
      'ingestion', jsonb_build_object(
        's3_key', 'v1-markdown-files/vct/VCT_Approved_Stripper_And_Finish_Products.md',
        'source_uri', null,
        'title', 'VCT Approved Stripper & Finish Products',
        'specialist', 'floor_vct',
        'doc_type', 'general',
        'product_line_key', null,
        'status', 'ingested',
        'manually_authored', true,
        'ticket', 'B0-1053'
      )
    ),
    timezone('utc', now())
  )
  on conflict (source_schema, source_table, source_pk, source_locale) do nothing
  returning id
),
resolved_source as (
  select id from new_source
  union all
  select id from rag.source_record
  where source_schema = 'knowledge'
    and source_table = 'file'
    and source_pk = 'b0-1053-vct-approved-products'
    and source_locale = 'EN'
  limit 1
),
new_document as (
  insert into rag.document
    (document_key, source_record_id, entity_id, document_kind, title, language_code,
     body_text, body_markdown, summary, token_count, metadata, ingested_by)
  select
    'knowledge:b0-1053-vct-approved-products',
    resolved_source.id,
    null,
    'knowledge',
    'VCT Approved Stripper & Finish Products',
    'EN',
    $body_text$VCT Approved Stripper & Finish Products

Audience: Customer-facing
Relevant product / process: Naming Betco's current stripper and finish product lineup for VCT (Vinyl Composition Tile) floors -- which specific products to use, by brand name.

What Stripping and Finish Products Should I Use for My VCT Floor?

Betco makes a dedicated line of floor strippers and floor finishes built for VCT (Vinyl Composition Tile). Which specific product is the best fit for a given floor depends on traffic, current finish buildup, and how much ongoing maintenance (burnishing, recoat frequency) the facility can sustain -- see "VCT Finish Selection" and "How to Select a VCT Floor Finish" for that decision framework. This article is the name-by-name product list those decisions point to.

Betco VCT Floor Strippers:
Ax-It Plus, Emulsinator, Unlock, Extreme, Extreme Ultra.

Betco PFAS-Free VCT Floor Finishes:
Glare, Finish 101, BetcoBest Low Maintenance Floor Finish, Hard As Nails, Hi-Tech, Photon Max, Untouchable (with SRT), Hybrid.

How to Match a Product to the Job

Match the stripper to the amount and age of finish buildup on the floor -- heavier or older buildup generally calls for a higher-active stripper and a longer dwell time.

Match the finish to the maintenance program the facility can actually sustain -- low, medium, or frequent maintenance, with burnishing capacity as the deciding factor (see VCT Finish Selection).

Exact dilution ratios, coverage rates, contact/dwell times, and other label specs differ product to product. Always confirm those numbers on the specific product's own label rather than from memory or a general guide.

Limitations, Warnings, and Exceptions

This article names the current Betco VCT stripper and finish product lineup. It is not a substitute for the product label.

Always follow the dilution ratio, dwell/contact time, and application directions printed on the specific product's label before use.

Related Terminology

VCT (Vinyl Composition Tile); floor stripper; floor finish; PFAS-free; dwell time; burnishing; scrub & recoat; product label.$body_text$,
    $body_md$# VCT Approved Stripper & Finish Products

**Audience:** Customer-facing
**Relevant product / process:** Naming Betco's current stripper and finish product lineup for VCT (Vinyl Composition Tile) floors — which specific products to use, by brand name.

## What Stripping and Finish Products Should I Use for My VCT Floor?

Betco makes a dedicated line of floor strippers and floor finishes built for VCT (Vinyl Composition Tile). Which specific product is the best fit for a given floor depends on traffic, current finish buildup, and how much ongoing maintenance (burnishing, recoat frequency) the facility can sustain — see "VCT Finish Selection" and "How to Select a VCT Floor Finish" for that decision framework. This article is the name-by-name product list those decisions point to.

### Betco VCT Floor Strippers
- Ax-It Plus
- Emulsinator
- Unlock
- Extreme
- Extreme Ultra

### Betco PFAS-Free VCT Floor Finishes
- Glare
- Finish 101
- BetcoBest Low Maintenance Floor Finish
- Hard As Nails
- Hi-Tech
- Photon Max
- Untouchable (with SRT)
- Hybrid

## How to Match a Product to the Job
- Match the stripper to the amount and age of finish buildup on the floor — heavier or older buildup generally calls for a higher-active stripper and a longer dwell time.
- Match the finish to the maintenance program the facility can actually sustain — low, medium, or frequent maintenance, with burnishing capacity as the deciding factor (see VCT Finish Selection).
- Exact dilution ratios, coverage rates, contact/dwell times, and other label specs differ product to product. Always confirm those numbers on the specific product's own label rather than from memory or a general guide.

## Limitations, Warnings, and Exceptions
- This article names the current Betco VCT stripper and finish product lineup. It is not a substitute for the product label.
- Always follow the dilution ratio, dwell/contact time, and application directions printed on the specific product's label before use.

## Related Terminology
VCT (Vinyl Composition Tile); floor stripper; floor finish; PFAS-free; dwell time; burnishing; scrub & recoat; product label.
$body_md$,
    'Names Betco''s current VCT stripper lineup (Ax-It Plus, Emulsinator, Unlock, Extreme, Extreme Ultra) and PFAS-free finish lineup (Glare, Finish 101, BetcoBest Low Maintenance, Hard As Nails, Hi-Tech, Photon Max, Untouchable, Hybrid) by brand name, and points to each product''s own label for exact specs.',
    260,
    jsonb_build_object(
      'source', 'knowledge',
      's3_key', 'v1-markdown-files/vct/VCT_Approved_Stripper_And_Finish_Products.md',
      'source_uri', null,
      'specialist', 'floor_vct',
      'doc_type', 'general',
      'product_line_key', null,
      'manually_authored', true,
      'ticket', 'B0-1053'
    ),
    'system:b0-1053-migration'
  from resolved_source
  limit 1
  on conflict (document_key) do nothing
  returning id
),
resolved_document as (
  select id from new_document
  union all
  select id from rag.document where document_key = 'knowledge:b0-1053-vct-approved-products'
  limit 1
)
insert into rag.document_chunk
  (chunk_key, document_id, chunk_index, section_path, heading, chunk_text, token_count, metadata)
select
  'knowledge:b0-1053-vct-approved-products:' || vals.chunk_index,
  resolved_document.id,
  vals.chunk_index,
  vals.section_path,
  vals.heading,
  vals.chunk_text,
  ceil(char_length(vals.chunk_text) / 4.0)::int,
  jsonb_build_object('specialist', 'floor_vct', 'doc_type', 'general')
from resolved_document
cross join (
  values
    (
      0,
      array['VCT Approved Stripper & Finish Products', 'What Stripping and Finish Products Should I Use for My VCT Floor?'],
      'What Stripping and Finish Products Should I Use for My VCT Floor?',
      $chunk0$Betco makes a dedicated line of floor strippers and floor finishes built for VCT (Vinyl Composition Tile). Which specific product is the best fit for a given floor depends on traffic, current finish buildup, and how much ongoing maintenance (burnishing, recoat frequency) the facility can sustain -- see "VCT Finish Selection" and "How to Select a VCT Floor Finish" for that decision framework. This article is the name-by-name product list those decisions point to.

Betco VCT Floor Strippers:
Ax-It Plus, Emulsinator, Unlock, Extreme, Extreme Ultra.

Betco PFAS-Free VCT Floor Finishes:
Glare, Finish 101, BetcoBest Low Maintenance Floor Finish, Hard As Nails, Hi-Tech, Photon Max, Untouchable (with SRT), Hybrid.$chunk0$
    ),
    (
      1,
      array['VCT Approved Stripper & Finish Products', 'How to Match a Product to the Job'],
      'How to Match a Product to the Job',
      $chunk1$Match the stripper to the amount and age of finish buildup on the floor -- heavier or older buildup generally calls for a higher-active stripper and a longer dwell time.

Match the finish to the maintenance program the facility can actually sustain -- low, medium, or frequent maintenance, with burnishing capacity as the deciding factor (see VCT Finish Selection).

Exact dilution ratios, coverage rates, contact/dwell times, and other label specs differ product to product. Always confirm those numbers on the specific product's own label rather than from memory or a general guide. This article names the current Betco VCT stripper and finish product lineup only -- it is not a substitute for the product label.$chunk1$
    )
) as vals(chunk_index, section_path, heading, chunk_text)
on conflict (chunk_key) do nothing;
