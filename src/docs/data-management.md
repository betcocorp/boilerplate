# Data Management

## Overview

This document explains how data is organized in `bex2.0`, what each schema is responsible for, and how the new `rag` schema should be used going forward.

The short version:

- `legacy` remains the source of truth for the product catalog and related business content.
- `public` should remain available for standard app-owned tables when needed, but it should not be used to remodel or extend the legacy catalog.
- `rag` is a new derived schema built specifically for retrieval, chunking, metadata filtering, and vector search.

This separation is intentional. The application needs to support existing legacy systems without changing their assumptions, while also building a modern retrieval layer that is optimized for AI use cases.

## Current Schemas

## `legacy`

The `legacy` schema contains the current product and content model that powers existing catalog experiences.

It includes records such as:

- Products
- Product descriptions
- Product lines
- Product attributes
- Product images
- Technical specifications
- Documents
- Videos
- Related supporting lookup tables

### Purpose

The purpose of `legacy` is compatibility. It exists to preserve the current structure expected by other applications and existing business workflows.

### Strengths

- Contains rich product and content data.
- Already supports product pages and product-related content assembly.
- Holds the source information needed to build a strong RAG corpus.

### Limitations

- Relationships are often indirect and inferred instead of enforced with explicit foreign keys.
- Data is modeled for legacy catalog rendering, not semantic retrieval.
- Meaningful text is spread across many tables and fields.
- Some fields are generic or weakly typed, which makes AI indexing less reliable.
- It is not designed around documents, chunks, embeddings, or hybrid search.

### Rule

`legacy` must remain unchanged by RAG-specific work. It is the upstream source system, not the retrieval layer.

## `public`

`public` is the default Postgres and Supabase schema for app-owned tables and standard application data.

### Purpose

Its purpose is to hold conventional application tables, settings, operational records, or future app-native models that are not part of the legacy catalog.

### Why we are not using `public` for RAG

- RAG data is a distinct concern from operational app data.
- Keeping it in `public` would blur the line between business tables and derived AI artifacts.
- A dedicated schema is easier to permission, reason about, migrate, and maintain.
- Isolation reduces the risk of accidentally coupling retrieval infrastructure to unrelated app features.

## Why a Separate `rag` Schema

The `rag` schema should be treated as a purpose-built derived data layer.

It exists because retrieval systems need a different shape than transactional or legacy systems. A RAG system does not primarily retrieve rows. It retrieves well-formed, semantically meaningful text units with clean metadata and stable identifiers.

That is different from how the legacy catalog is currently organized.

Using a dedicated `rag` schema gives us:

- Isolation from legacy systems
- A clear source-to-derived pipeline
- Better permissions and operational safety
- Freedom to optimize for search and retrieval without breaking existing apps
- A place to store embeddings, chunks, summaries, ingestion metadata, and retrieval indexes

## Architecture Principles

The data architecture should follow these principles:

- `legacy` is read-only from the perspective of RAG ingestion.
- `rag` is fully derived from upstream sources.
- Retrieval documents should be assembled from business meaning, not from raw table rows.
- Structured metadata and retrievable text should be stored separately but linked.
- Chunking and embedding should happen after document construction, not before.
- Re-indexing should be incremental and based on source change detection.

## Proposed `rag` Schema

The `rag` schema is designed to turn fragmented legacy content into retrieval-ready documents.

### Core tables

#### `rag.source_record`

Tracks each upstream record or source object that feeds the retrieval corpus.

Purpose:

- Identify where content came from
- Track checksums and last-seen timestamps
- Support incremental sync and deactivation
- Preserve lineage from `rag` back to `legacy`

Typical fields:

- Source schema
- Source table
- Source primary key
- Source type
- Locale
- Checksum
- Active status
- Metadata

#### `rag.entity`

Represents canonical business entities used for metadata filtering and graph relationships.

Purpose:

- Model business objects like products or product lines
- Provide stable filter keys like `product_key`, `product_line_key`, and `sku`
- Separate business identity from retrievable text

Typical entity types:

- Product
- Product line
- Document
- Video

#### `rag.entity_link`

Stores relationships between canonical entities.

Purpose:

- Capture explicit links such as product-to-product-line or product-to-document
- Support richer retrieval and future graph-aware reasoning
- Replace implicit polymorphic relationship patterns with clear link records in the derived layer

#### `rag.document`

Stores retrieval-ready documents assembled from source content.

Purpose:

- Hold well-formed text intended for semantic search
- Preserve titles, summaries, body text, and metadata
- Represent a meaningful unit such as a product profile, manual, technical document, or transcript

Examples of document kinds:

- `product_profile`
- `manual`
- `technical_document`
- `video_transcript`
- `faq_entry`

#### `rag.document_chunk`

Stores chunked sections of `rag.document` for lexical and vector retrieval.

Purpose:

- Break large documents into semantically useful retrieval units
- Store embeddings
- Support hybrid search across both vectors and text indexes

Typical fields:

- Document ID
- Chunk index
- Heading
- Chunk text
- Token count
- Embedding model
- Embedding vector
- Metadata

## How the RAG Flow Works

The `rag` schema should be populated through a derived pipeline:

1. Read source content from `legacy`
2. Assemble business-friendly documents from related records
3. Store source lineage in `rag.source_record`
4. Upsert canonical entities into `rag.entity`
5. Store retrieval-ready text in `rag.document`
6. Split documents into chunks in `rag.document_chunk`
7. Generate embeddings for each chunk
8. Query chunks during retrieval and use metadata to filter results

## Example: Product Profile Construction

A single product profile document should be assembled from multiple legacy sources, not copied from a single row.

Example inputs:

- `legacy.products`
- `legacy.products_descr`
- `legacy.prod_line`
- `legacy.prod_line_descr`
- `legacy.feature_srch`
- `legacy.product_direction_of_use`
- `legacy.tech_spec`
- `legacy.tech_spec_def`
- `legacy.documents`

Example output:

- Product identity
- SKU and business identifiers
- Product line context
- Short and full description
- Feature bullets
- Directions for use
- Technical specifications
- Related document references

This gives the retrieval system a coherent, searchable knowledge document instead of forcing it to reconstruct meaning from disconnected rows.

## Why This Is Beneficial

### Better retrieval quality

The RAG schema stores clean, context-rich documents instead of sparse relational fragments. That improves semantic similarity search and reduces irrelevant retrievals.

### Better chunking

Chunking works best when the source text is already coherent. Building complete documents before chunking leads to better retrieval granularity and better answer grounding.

### Better filtering

Because entity identity and metadata are modeled separately, retrieval can filter by:

- Product
- Product line
- SKU
- Document type
- Language
- Status

This is much harder to do consistently when everything is embedded directly from ad hoc joined rows.

### Better maintainability

The `rag` schema can evolve independently of `legacy`. New document types, transcripts, extracted PDFs, summaries, and embedding models can be added without risk to existing systems.

### Better operational safety

Because `legacy` is not modified, older apps keep working exactly as they do today. The RAG pipeline becomes additive rather than disruptive.

## What Belongs in `rag`

The following types of data belong in `rag`:

- Derived product profile documents
- Extracted document text from PDFs or files
- Video transcripts
- Chunked retrieval records
- Embeddings
- Search indexes
- Sync metadata
- Source lineage metadata

The following do not belong in `rag`:

- Operational source-of-truth catalog rows
- Legacy app-specific workflow data
- UI-only temporary state
- Anything that other legacy systems depend on directly

`rag.product_line_web_url` (B0-1074) is one concrete example of a derived, read-only view over
`legacy`: it computes betco.com product-page URLs from `legacy.products."OnWeb"` and
`legacy.prod_line` at query time and is never written to directly — see
`rag-data-relationships.md`'s "Product page URL derivation" section for the full join/predicate.

## Recommended Usage Rules

- Never write RAG-specific fields back into `legacy`.
- Never treat `rag` as the source of truth for product operations.
- Use `legacy` for source extraction.
- Use `rag.document` and `rag.document_chunk` for retrieval.
- Use `rag.entity` and `rag.entity_link` for metadata filters and relationship traversal.
- Rebuild or resync derived RAG records whenever upstream content changes.

## Current Implementation Direction

The current implementation direction is:

- Keep `legacy` intact
- Introduce a dedicated `rag` schema
- Build product-profile documents first
- Add chunking and embeddings next
- Expand later to manuals, technical docs, and transcripts

This gives the project a safe first step into RAG without requiring a risky redesign of the existing catalog model.

## Summary

The existing `legacy` schema is valuable as an upstream content source, but it is not shaped correctly for RAG on its own.

The right approach is not to rewrite `legacy` or to overload `public`. The right approach is to create a dedicated `rag` schema that:

- Preserves source lineage
- Builds retrieval-ready documents
- Supports chunking and embeddings
- Enables metadata-aware search
- Keeps existing systems isolated and safe

That architecture gives us a modern AI-ready retrieval layer while respecting the constraints of the current platform.
