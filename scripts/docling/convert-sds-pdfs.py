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

    # Existing manifest mode
    uv run --with docling scripts/docling/convert-sds-pdfs.py <workdir> [--force]

    # Standalone directory mode
    uv run --with docling scripts/docling/convert-sds-pdfs.py \
        --input-dir <pdf-directory> --output-dir <markdown-directory> [--force]

Directory mode is selected automatically when both --input-dir and --output-dir are supplied.
It recursively converts PDF files and mirrors their relative paths under the output directory.
Use --force to overwrite existing markdown when comparing conversion settings. Use
--experiment to change exactly one standard-pipeline variable, or to select an isolated
VLM conversion profile. Use --page-range to limit expensive comparisons to specific pages.

First run downloads docling's layout/OCR models (~1GB) and is slow. Later runs reuse
the cache in ~/.cache/docling.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from importlib.metadata import version
from pathlib import Path


def parse_page_range(value: str) -> tuple[int, int]:
    try:
        start_text, separator, end_text = value.partition("-")
        start = int(start_text)
        end = int(end_text) if separator else start
    except ValueError as error:
        raise argparse.ArgumentTypeError("page range must be START or START-END") from error
    if start < 1 or end < start:
        raise argparse.ArgumentTypeError(
            "page range must use positive, increasing 1-based page numbers"
        )
    return start, end


EXPERIMENTS = (
    "baseline",
    "baseline-pdfium",
    "backend-text",
    "layout-heron-101",
    "layout-egret-large",
    "no-cell-matching",
    "granite-docling",
    "granite-native-text",
    "granite-native-pdfium",
    "granite-hires",
    "mineru2-pro",
    "nemotron-parse-v2",
    "nanonets-ocr2",
    "smoldocling-native-text",
    "smoldocling-native-pdfium",
    "full-page-ocr",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert SDS PDFs to Markdown with Docling.",
    )
    parser.add_argument(
        "workdir",
        nargs="?",
        type=Path,
        help="Manifest-mode work directory containing manifest.json.",
    )
    parser.add_argument(
        "--input-dir",
        type=Path,
        help="Directory-mode PDF root; searched recursively.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="Directory-mode Markdown root; relative input paths are mirrored here.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing non-empty Markdown files.",
    )
    parser.add_argument(
        "--page-range",
        type=parse_page_range,
        metavar="START[-END]",
        help="Convert only this inclusive, 1-based PDF page range.",
    )
    parser.add_argument(
        "--experiment",
        choices=EXPERIMENTS,
        default="baseline",
        help=(
            "Conversion profile. Baseline uses no OCR, forced backend text, the default "
            "layout model, and cell matching. Each other standard profile changes one setting."
        ),
    )
    args = parser.parse_args()

    directory_mode = args.input_dir is not None or args.output_dir is not None
    if directory_mode and (args.input_dir is None or args.output_dir is None):
        parser.error("--input-dir and --output-dir must be supplied together")
    if directory_mode and args.workdir is not None:
        parser.error("workdir cannot be combined with --input-dir/--output-dir")
    if not directory_mode and args.workdir is None:
        parser.error("supply either <workdir> or --input-dir with --output-dir")

    return args


def build_converter(experiment: str):
    from docling.datamodel.base_models import InputFormat
    from docling.document_converter import DocumentConverter, PdfFormatOption

    use_pdfium = experiment in {
        "baseline-pdfium",
        "granite-native-pdfium",
        "smoldocling-native-pdfium",
    }
    pdfium_backend = None
    if use_pdfium:
        from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend

        pdfium_backend = PyPdfiumDocumentBackend

    def pdf_format_option(**kwargs):
        if pdfium_backend is not None:
            kwargs["backend"] = pdfium_backend
        return PdfFormatOption(**kwargs)

    vlm_presets = {
        "granite-docling": "granite_docling",
        "granite-native-text": "granite_docling",
        "granite-native-pdfium": "granite_docling",
        "granite-hires": "granite_docling",
        "mineru2-pro": "mineru2_pro",
        "nemotron-parse-v2": "nemotron_parse_v2",
        "nanonets-ocr2": "nanonets_ocr2",
        "smoldocling-native-text": "smoldocling",
        "smoldocling-native-pdfium": "smoldocling",
    }
    if experiment in vlm_presets:
        from docling.datamodel.pipeline_options import (
            VlmConvertOptions,
            VlmPipelineOptions,
        )
        from docling.pipeline.vlm_pipeline import VlmPipeline

        preset = vlm_presets[experiment]
        try:
            vlm_options = VlmConvertOptions.from_preset(preset)
        except (KeyError, ValueError) as error:
            raise RuntimeError(
                f"Docling {version('docling')} does not provide VLM preset {preset!r}; "
                "install one Docling version that provides it and use that same version "
                "for the corresponding control run"
            ) from error

        if experiment in {
            "granite-native-text",
            "granite-native-pdfium",
            "smoldocling-native-text",
            "smoldocling-native-pdfium",
        }:
            # Native replacement is limited to DocTags presets whose predicted boxes can
            # be reconciled with PDF-backend text. Do not enable it for Markdown presets.
            vlm_options.force_backend_text = True
        elif experiment == "granite-hires":
            # Experimental values: increase page rendering resolution without changing the
            # model or enabling backend-text replacement.
            vlm_options.force_backend_text = False
            vlm_options.scale = 3.0
            vlm_options.max_size = 2048

        return DocumentConverter(
            format_options={
                InputFormat.PDF: pdf_format_option(
                    pipeline_cls=VlmPipeline,
                    pipeline_options=VlmPipelineOptions(vlm_options=vlm_options),
                ),
            }
        )

    from docling.datamodel.pipeline_options import (
        HeadingHierarchyOptions,
        LayoutObjectDetectionOptions,
        OcrMode,
        PdfPipelineOptions,
        RapidOcrOptions,
        TableFormerMode,
    )

    pdf_options = PdfPipelineOptions(
        # OCR stays disabled except in the explicit full-page OCR profile.
        do_ocr=experiment == "full-page-ocr",
        do_table_structure=True,
        heading_hierarchy_options=HeadingHierarchyOptions(
            enabled=True,
            use_bookmarks=True,
            use_numbering=True,
            use_style=False,
            max_level=4,
        ),
        do_code_enrichment=False,
        do_formula_enrichment=False,
        do_picture_classification=False,
        do_picture_description=False,
        do_chart_extraction=False,
        force_backend_text=experiment not in {"backend-text", "full-page-ocr"},
        document_timeout=300,
        generate_page_images=False,
        generate_picture_images=False,
        generate_parsed_pages=False,
    )
    pdf_options.table_structure_options.mode = TableFormerMode.ACCURATE
    pdf_options.table_structure_options.do_cell_matching = experiment != "no-cell-matching"
    if experiment == "full-page-ocr":
        pdf_options.ocr_options = RapidOcrOptions(
            mode=OcrMode.FULL_PAGE,
            lang=["iso:en"],
        )

    layout_presets = {
        "layout-heron-101": "layout_heron_101",
        "layout-egret-large": "layout_egret_large",
    }
    if experiment in layout_presets:
        pdf_options.layout_options = LayoutObjectDetectionOptions.from_preset(
            layout_presets[experiment]
        )

    return DocumentConverter(
        format_options={
            InputFormat.PDF: pdf_format_option(pipeline_options=pdf_options),
        }
    )


def main() -> int:
    args = parse_args()
    jobs: list[tuple[str, Path, Path]] = []

    if args.input_dir is not None and args.output_dir is not None:
        input_dir = args.input_dir.resolve()
        output_dir = args.output_dir.resolve()
        if not input_dir.is_dir():
            print(f"Input directory does not exist: {input_dir}", file=sys.stderr)
            return 1

        pdf_paths = sorted(
            path for path in input_dir.rglob("*") if path.is_file() and path.suffix.lower() == ".pdf"
        )
        for pdf_path in pdf_paths:
            relative_path = pdf_path.relative_to(input_dir)
            md_path = (output_dir / relative_path).with_suffix(".md")
            jobs.append((relative_path.as_posix(), pdf_path, md_path))
        destination = output_dir
    else:
        workdir = args.workdir.resolve()
        manifest_path = workdir / "manifest.json"
        if not manifest_path.exists():
            print(
                f"No manifest at {manifest_path}. Run the TS script with --plan first.",
                file=sys.stderr,
            )
            return 1

        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        md_dir = workdir / "md"
        for doc in manifest.get("documents", []):
            case_id = doc.get("caseId", doc["documentId"])
            jobs.append(
                (
                    case_id,
                    Path(doc["pdfPathAbsolute"]),
                    md_dir / f"{case_id}.md",
                )
            )
        destination = md_dir

    if not jobs:
        print("No PDF files found to convert.", file=sys.stderr)
        return 1

    destination.mkdir(parents=True, exist_ok=True)

    # Imported/configured late so CLI and input errors do not pay the model-loading cost.
    converter = build_converter(args.experiment)
    print(f"docling_version={version('docling')}")
    print(f"experiment={args.experiment}")
    converted, failed, skipped = 0, 0, 0

    for index, (case_id, pdf_path, md_path) in enumerate(jobs, start=1):
        if not pdf_path.exists():
            print(f"[{index}/{len(jobs)}] {case_id}: no pdf at {pdf_path}, skipped")
            skipped += 1
            continue
        if not args.force and md_path.exists() and md_path.stat().st_size > 0:
            print(f"[{index}/{len(jobs)}] {case_id}: already converted")
            skipped += 1
            continue

        started = time.monotonic()
        try:
            convert_options = (
                {"page_range": args.page_range} if args.page_range is not None else {}
            )
            result = converter.convert(str(pdf_path), **convert_options)
            md_path.parent.mkdir(parents=True, exist_ok=True)
            md_path.write_text(result.document.export_to_markdown(), encoding="utf-8")
            elapsed = time.monotonic() - started
            print(f"[{index}/{len(jobs)}] {case_id}: {md_path.stat().st_size} chars in {elapsed:.1f}s")
            converted += 1
        except Exception as error:  # noqa: BLE001 - one bad PDF must not end the batch
            print(f"[{index}/{len(jobs)}] {case_id}: FAILED {error}", file=sys.stderr)
            error_path = md_path.with_suffix(".error.txt")
            error_path.parent.mkdir(parents=True, exist_ok=True)
            error_path.write_text(str(error), encoding="utf-8")
            failed += 1

    print(f"\nconverted={converted} skipped={skipped} failed={failed} -> {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
