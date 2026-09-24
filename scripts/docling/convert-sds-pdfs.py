#!/usr/bin/env python3
"""
Docling conversion stage for the PDF comparison manifests produced by
scripts/compare-docling-chunks.ts and scripts/compare-docling-pdf-corpora.ts.

Converts every PDF named in <workdir>/manifest.json into markdown with Docling, writing
<workdir>/md/<caseId>.md (or <documentId>.md for the original SDS manifest). The PDFs stay
in their source dump; only the markdown lands in the workdir.

Deliberately dumb: it reads the manifest the TS script wrote, converts, and records
success/failure per document. All comparison logic lives in the TS script so there is
one implementation of the metrics, not two.

Usage (no install required — uv fetches docling into a throwaway env):

    uv run --with docling scripts/docling/convert-sds-pdfs.py <workdir>

First run downloads docling's layout/OCR models (~1GB) and is slow. Later runs reuse
the cache in ~/.cache/docling.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: convert-sds-pdfs.py <workdir>", file=sys.stderr)
        return 2

    workdir = Path(sys.argv[1]).resolve()
    manifest_path = workdir / "manifest.json"
    if not manifest_path.exists():
        print(f"No manifest at {manifest_path}. Run the TS script with --plan first.", file=sys.stderr)
        return 1

    manifest = json.loads(manifest_path.read_text())
    docs = manifest.get("documents", [])
    md_dir = workdir / "md"
    md_dir.mkdir(parents=True, exist_ok=True)

    # Imported late so the usage/manifest errors above do not pay the import cost.
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import (
        HeadingHierarchyOptions,
        OcrAutoOptions,
        OcrMode,
        PdfPipelineOptions,
        TableFormerMode,
    )
    from docling.document_converter import DocumentConverter, PdfFormatOption

    pdf_options = PdfPipelineOptions(
        # Core extraction
        do_ocr=True,
        do_table_structure=True,
        # Preserve SDS structural hierarchy
        heading_hierarchy_options=HeadingHierarchyOptions(
            enabled=True,
            use_bookmarks=True,
            use_numbering=True,
            use_style=False,
            max_level=4,
        ),
        # Keep these enrichment stages off
        do_code_enrichment=False,
        do_formula_enrichment=False,
        do_picture_classification=False,
        do_picture_description=False,
        do_chart_extraction=False,
        # Avoid forcing potentially broken PDF text
        force_backend_text=False,
        # Operational safeguard
        document_timeout=300,
        # Debug artifacts off in normal runs
        generate_page_images=False,
        generate_picture_images=False,
        generate_parsed_pages=False,
    )
    pdf_options.ocr_options = OcrAutoOptions(
        mode=OcrMode.DEFAULT,
        lang=["iso:en"],
    )
    pdf_options.table_structure_options.mode = TableFormerMode.ACCURATE
    pdf_options.table_structure_options.do_cell_matching = True

    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_options),
        }
    )
    converted, failed, skipped = 0, 0, 0

    for index, doc in enumerate(docs, start=1):
        case_id = doc.get("caseId", doc["documentId"])
        pdf_path = Path(doc["pdfPathAbsolute"])
        md_path = md_dir / f"{case_id}.md"

        if not pdf_path.exists():
            print(f"[{index}/{len(docs)}] {case_id}: no pdf at {pdf_path}, skipped")
            skipped += 1
            continue
        if md_path.exists() and md_path.stat().st_size > 0:
            print(f"[{index}/{len(docs)}] {case_id}: already converted")
            skipped += 1
            continue

        started = time.monotonic()
        try:
            result = converter.convert(str(pdf_path))
            md_path.write_text(result.document.export_to_markdown(), encoding="utf-8")
            elapsed = time.monotonic() - started
            print(f"[{index}/{len(docs)}] {case_id}: {md_path.stat().st_size} chars in {elapsed:.1f}s")
            converted += 1
        except Exception as error:  # noqa: BLE001 - one bad PDF must not end the batch
            print(f"[{index}/{len(docs)}] {case_id}: FAILED {error}", file=sys.stderr)
            (md_dir / f"{case_id}.error.txt").write_text(str(error), encoding="utf-8")
            failed += 1

    print(f"\nconverted={converted} skipped={skipped} failed={failed} -> {md_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
