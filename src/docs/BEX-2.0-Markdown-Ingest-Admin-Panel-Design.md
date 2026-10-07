# BEX 2.0 — Markdown Knowledge Ingest: Admin Panel Design

**Prepared for:** Tom Bird
**Date:** July 15, 2026
**Status:** Design proposal (grounded in `dev` @ `9ae36e57` + live DB)
**Goal:** An admin panel that ingests the curated v1 markdown files into the `rag` corpus, modeled on the existing SDS ingest flow, sourced from `s3://retool-360/v1-markdown-files`.

**Relationship to existing docs:** realizes `rag-execution-plan.md` Phase 4.1 (admin-triggered ingestion) for a new `knowledge` source, reusing the shipped SDS pipeline (`admin/sds/pipeline.ts`). See `BEX-2.0-Corpus-Assessment-and-Reconciliation-Strategy.md` §6 for the full doc reconciliation.

---

## 1. What we're mirroring

The SDS ingest is a four-stage, batched, S3-backed pipeline with a status dashboard:

- **Pipeline:** `src/app/(authenticated)/admin/sds/pipeline.ts` — discover (S3 list) → `register-seed` (create `rag.source_record`) → `ingest-next/all` (download, parse, upsert `rag.document`) → chunk → `embed-next/all` (`syncDocumentChunkEmbeddings`), plus `retry-failed`.
- **Chunking:** `src/lib/rag/sds-sync-actions.ts` → `sync_sds_chunks` RPC, driven by a form action with batched `has_more`/`remaining` + a run history.
- **Status model:** `SdsDashboardStatus` (seeded / registered / ingested / failed / chunks / embedded / pending) with per-document rows and graceful S3-unavailable fallback.

We reproduce this shape for markdown, with the differences below.

## 2. Key differences from SDS (these matter)

| Concern | SDS | Markdown panel |
|---|---|---|
| Bucket | `AWS_S3_BUCKET_NAME` (SDS bucket) | **`retool-360`** (same bucket as test sets) |
| Prefix | `sds/` (`SDS_S3_PREFIX`) | **`v1-markdown-files/`** |
| Credentials | `AWS_SDS_READ_ACCESS_KEY_ID` / `_SECRET` | **`AWS_360_*`** (per `lib/tests/storage.ts`) |
| Region | `us-east-2` (`AWS_SDS_REGION`) | **`us-east-1`** (`AWS_360_REGION`) |
| File type | `.pdf` → parse with `pdfjs-dist` | `.md` → **no parsing**, text is already clean |
| Body field | `body_text` (parsed), `body_markdown` null | **`body_markdown` = raw md**, `body_text` = stripped |
| `document_kind` | `sds` | **`knowledge`** |
| `source_type` | `s3_pdf` | **`s3_markdown`** |
| Chunking | `sync_sds_chunks` (page/section) | **heading-aware** md splitter (see §5) |

**⚠️ Credential gap to resolve first:** `lib/tests/storage.ts` only defines `AWS_360_WRITE_*` keys (it uploads test CSVs). Reading `v1-markdown-files` for ingest needs **read** access — add `AWS_360_READ_ACCESS_KEY_ID` / `AWS_360_READ_SECRET_ACCESS_KEY` (or confirm the write key also has `s3:GetObject`/`ListBucket` on `retool-360`). Document in §8 env of the corpus assessment.

## 3. Route & files (new)

Mirror the SDS layout under a new admin route:

```
src/app/(authenticated)/admin/knowledge/
  page.tsx            # server component: renders dashboard from getKnowledgeDashboardStatus()
  pipeline.ts         # discover / register / ingest / embed  (adapted from sds/pipeline.ts)
  manifest.ts         # KNOWLEDGE_S3_* defaults + optional per-file overrides (title/specialist/doc_type)
  actions.ts          # 'use server' run action (mode + batchSize) + chunk action
  KnowledgePanel.tsx  # client: run buttons, progress, per-file table, history
```

Constants (analogous to SDS):

```ts
const SOURCE_SCHEMA = 'knowledge';
const SOURCE_TABLE  = 'file';
const SOURCE_TYPE   = 's3_markdown';
const DOCUMENT_KIND = 'knowledge';
const KNOWLEDGE_S3_BUCKET_DEFAULT = 'retool-360';
const KNOWLEDGE_S3_PREFIX_DEFAULT = 'v1-markdown-files/';
```

## 4. Discovery & document creation

`discoverKnowledgeSeedDocuments()` — list `.md` keys under the prefix (same `ListObjectsV2` pagination as `listS3PdfKeys`, filtering `extname === '.md'`), then derive metadata from the S3 path and optional YAML frontmatter:

- **specialist** ← top folder in the key (`1 - Restroom Specialist` → `bathroom`, `3 - SportsZone` / `4 - VCT` → `floor`, `2 - Product` → `product`), overridable in `manifest.ts`.
- **doc_type** ← filename/heading heuristic (`troubleshooting` | `faq` | `howto` | `glossary` | `workbook`).
- **title** ← frontmatter `title` or `inferTitle(fileName)`.
- **productLineKey** ← `resolveProductLineKeyByName()` on frontmatter/product mentions when unambiguous; else null now, backfilled by the alias table (structured-fact design §7 / assessment §4).

`ingestSeedDocument()` — `GetObject` → decode UTF-8 (no PDF parse) → strip frontmatter → `upsertDocument` with `document_kind='knowledge'`, `body_markdown = raw`, `body_text = stripped`, `document_key = 'knowledge:<sha1(key)>'`, `metadata = { source:'knowledge', s3_key, source_uri, specialist, doc_type, product_line_key }`. Reuse the SDS `register/ingest/mark` state machine verbatim — only the fetch+parse step changes.

## 5. Chunking (the one net-new bit)

SDS chunks via the `sync_sds_chunks` RPC. Markdown is better served by a **heading-aware splitter** — these files are cleanly structured (`## Question`, `### Issue → Cause → Fix`), which is exactly the boundary we want a chunk to respect. Two options:

1. **Preferred:** a `sync_knowledge_chunks` RPC parallel to `sync_sds_chunks`, splitting on markdown headings into `document_chunk` rows with `section_path`/`heading` populated (these columns already exist and feed the tsvector + `match_corpus_chunks`).
2. **Faster to ship:** a TS chunker in `lib/rag/` that splits by heading with a token cap and writes `document_chunk` rows directly, then reuse `syncDocumentChunkEmbeddings({ documentKind: 'knowledge' })` for embeddings (writes `embedding_large` — the live column).

Either way, embeddings reuse the existing large-model path; no new embedding code.

## 6. Making the knowledge retrievable (must-do, else it's inert)

Ingesting is necessary but not sufficient. Per the v3 assessment, retrieval must be told the new kind exists:

- `match_corpus_chunks` / `match_product_chunks` are filtered by `scope`. Ensure `document_kind='knowledge'` is reachable under `scope:'all'` (it will be, since corpus RPCs aren't kind-restricted) — verify the RPC's kind handling.
- In `lib/retrieval/product-knowledge.ts`, `requiredDocumentKinds` is hardcoded to `['product_line_profile','sds']`. Add `'knowledge'` (or add a dedicated `retrieveKnowledge` helper in `product-guidance.ts`) so a how-to/troubleshooting chunk is **guaranteed a slot** in the curated bundle rather than only surfacing opportunistically.
- Consider a `topic`/intent → `knowledge` bias for troubleshooting-style questions.

## 7. Dashboard & run modes

Reuse the SDS UX 1:1: run buttons (`register-seed`, `ingest-next`, `ingest-all`, `retry-failed`, `chunk-next/all`, `embed-next/all`), a totals strip (seeded / registered / ingested / failed / chunks / embedded / pending), a per-file table (title · specialist · doc_type · status · chunk count · last error), and the graceful "S3 unavailable → last known records" fallback. Batched with `has_more`/`remaining` so large uploads process safely.

## 8. Sequencing

1. Confirm/add `AWS_360_READ_*` credentials with read on `retool-360`.
2. Scaffold `admin/knowledge/*` from the SDS files; swap constants + fetch step.
3. Heading-aware chunker (`sync_knowledge_chunks` RPC or TS splitter).
4. Add `'knowledge'` to `requiredDocumentKinds` + verify RPC scope reachability.
5. Ingest, then run an `/admin/tests` set of troubleshooting/how-to questions to confirm knowledge chunks are retrieved and cited.

## 9. Proposed Jira breakdown (for review)

- **Epic:** v1 markdown knowledge ingest.
  1. `AWS_360_READ_*` credentials + env wiring for `retool-360` reads.
  2. Scaffold `admin/knowledge/*` (pipeline/manifest/actions/page/panel) from SDS.
  3. Discovery + document creation for `document_kind='knowledge'` (specialist/doc_type metadata).
  4. Heading-aware markdown chunker + embeddings reuse.
  5. Retrieval wiring: add `knowledge` to `requiredDocumentKinds` (+ scope check).
  6. Eval set: troubleshooting/how-to retrieval regression.
