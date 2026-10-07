#!/usr/bin/env python3
"""
Experimental hybrid PDF-to-Markdown converter.

The standard Docling pipeline remains authoritative for document structure and genuine tables.
A second, deterministic pass inspects the born-digital PDF word cells retained by Docling,
finds repeated visual ``label : value`` rows, and inserts recovered Markdown tables before the
corresponding flattened block. The comparison output preserves original Docling content; a
separate ingestion output removes only the exact verified label/value lines represented by each
synthetic table.

The output directory receives a collision-safe subdirectory per PDF:

* ``<name>/hybrid.md``: additive comparison Markdown retaining flattened source text
* ``<name>/ingestion.md``: deduplicated Markdown for ingestion, preserving unmatched text
* ``<name>/baseline.md``: unmodified standard Docling Markdown
* ``<name>/key-values.json``: all recovered rows, coordinates, confidence, and placement status

Only blocks with a unique, strongly validated Markdown anchor enter ``hybrid.md``. Ambiguous or
unplaced detections remain report-only in ``key-values.json``.

Usage:

    uv run --with 'docling==2.131.0' \
      scripts/docling/convert-sds-pdfs-hybrid.py \
      --input-dir <pdf-directory> --output-dir <output-directory> [--force]

Pass ``--ingestion-manifest manifest.csv`` to emit a clean, directly uploadable ingestion
package containing the normalized manifest and exactly its declared Markdown objects. Diagnostic
artifacts are written to a sibling ``<output-directory>.artifacts`` directory. Partial documents
require explicit ``--include-partial``; unsupported documents always fail closed.

This is deliberately conservative: ambiguous detections are reported but are not silently
rewritten.
"""

from __future__ import annotations

import argparse
import csv
import html
import io
import json
import re
import shutil
import statistics
import sys
import time
import uuid
from dataclasses import asdict, dataclass, field, replace
from importlib.metadata import version
from pathlib import Path
from typing import Any

COLON_CHARACTERS = ":："
COLON_CLUSTER_TOLERANCE = 8.0
MIN_PAIRS_DEFAULT = 3
INCOMPLETE_LABEL_END = re.compile(
    r"(?:\b(?:and|or|of|to|the|for|with|in|on|at)|[/\-])$",
    re.I,
)
PHYSICAL_PROPERTY_LABEL = re.compile(
    r"(?:appearance|physical state|^form$|colou?r|odou?r|threshold|^ph(?:\s|$)|"
    r"melting|freezing|boiling|flash point|evaporation|flammab|explosi|"
    r"vapo[u]?r|relative density|specific gravity|density|solubility|"
    r"partition|auto.?ignition|decomposition|viscosity|particle size|"
    r"molecular weight|oxidising|oxidizing|pour point|flow time|softening point)",
    re.I,
)


@dataclass(frozen=True)
class PositionedWord:
    text: str
    left: float
    top: float
    right: float
    bottom: float

    @property
    def center_y(self) -> float:
        return (self.top + self.bottom) / 2

    @property
    def height(self) -> float:
        return self.bottom - self.top


@dataclass
class VisualLine:
    words: list[PositionedWord] = field(default_factory=list)

    @property
    def left(self) -> float:
        return min(word.left for word in self.words)

    @property
    def right(self) -> float:
        return max(word.right for word in self.words)

    @property
    def top(self) -> float:
        return min(word.top for word in self.words)

    @property
    def bottom(self) -> float:
        return max(word.bottom for word in self.words)

    @property
    def center_y(self) -> float:
        return statistics.mean(word.center_y for word in self.words)

    @property
    def text(self) -> str:
        return join_text(word.text for word in sorted(self.words, key=lambda word: word.left))


@dataclass
class KeyValueRow:
    label: str
    value: str
    top: float
    bottom: float
    colon_x: float
    label_left: float
    value_left: float | None
    verified: bool = False
    label_line: int | None = None
    value_line: int | None = None
    verification_mode: str | None = None
    source_lines: list[int] = field(default_factory=list)


@dataclass
class KeyValueBlock:
    page: int
    colon_x: float
    rows: list[KeyValueRow]
    inserted: bool = False
    insertion_anchor: str | None = None
    inserted_labels: list[str] = field(default_factory=list)
    omitted_labels: list[str] = field(default_factory=list)
    partial: bool = False
    confidence: str = "explicit-colon-alignment"


@dataclass(frozen=True)
class IngestionManifestRow:
    document_id: str
    s3_key: str
    markdown_path: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert PDFs with Docling and augment borderless key/value layouts.",
    )
    parser.add_argument("--input-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing hybrid, baseline, and report files.",
    )
    parser.add_argument(
        "--min-pairs",
        type=int,
        default=MIN_PAIRS_DEFAULT,
        help="Minimum explicit label/value rows required for a recovered block.",
    )
    parser.add_argument(
        "--ingestion-manifest",
        type=Path,
        help=(
            "Production-compatible manifest.csv whose s3_key paths resolve below "
            "--input-dir. When set, emit manifest.csv and its markdown_path objects."
        ),
    )
    parser.add_argument(
        "--include-partial",
        action="store_true",
        help=(
            "Allow explicitly requested partial documents in an ingestion package. "
            "Unsupported documents always fail closed."
        ),
    )
    args = parser.parse_args()
    if args.min_pairs < 2:
        parser.error("--min-pairs must be at least 2")
    if args.include_partial and args.ingestion_manifest is None:
        parser.error("--include-partial requires --ingestion-manifest")
    return args


MANIFEST_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.I,
)


def normalize_manifest_path(value: str, field: str, row_number: int) -> str:
    normalized = value.strip().replace("\\", "/")
    parts = normalized.split("/")
    if not normalized or normalized.startswith("/") or ".." in parts:
        raise ValueError(
            f"SDS markdown manifest row {row_number} has an unsafe {field}."
        )
    return normalized


def parse_ingestion_manifest(content: str) -> list[IngestionManifestRow]:
    reader = csv.DictReader(io.StringIO(content.lstrip("\ufeff")))
    required_fields = {"document_id", "s3_key", "markdown_path"}
    if reader.fieldnames is None or not required_fields.issubset(reader.fieldnames):
        raise ValueError(
            "SDS markdown manifest must contain document_id, s3_key, and markdown_path."
        )

    rows: list[IngestionManifestRow] = []
    document_ids: set[str] = set()
    source_keys: set[str] = set()
    markdown_paths: set[str] = set()
    for index, record in enumerate(reader, start=2):
        document_id = (record.get("document_id") or "").strip()
        if not MANIFEST_UUID_RE.fullmatch(document_id):
            raise ValueError(
                f"SDS markdown manifest row {index} has an invalid document_id."
            )
        # Normalize through UUID so output casing is deterministic without changing identity.
        document_id = str(uuid.UUID(document_id))
        source_key = normalize_manifest_path(
            record.get("s3_key") or "", "s3_key", index
        )
        markdown_path = normalize_manifest_path(
            record.get("markdown_path") or "", "markdown_path", index
        )
        if not source_key.casefold().endswith(".pdf"):
            raise ValueError(
                f"SDS markdown manifest row {index} does not reference a PDF s3_key."
            )
        if not markdown_path.casefold().endswith(".md"):
            raise ValueError(
                f"SDS markdown manifest row {index} is not a markdown object."
            )
        if (
            document_id in document_ids
            or source_key in source_keys
            or markdown_path in markdown_paths
        ):
            raise ValueError(
                f"SDS markdown manifest row {index} contains a duplicate identity."
            )
        document_ids.add(document_id)
        source_keys.add(source_key)
        markdown_paths.add(markdown_path)
        rows.append(IngestionManifestRow(document_id, source_key, markdown_path))
    if not rows:
        raise ValueError("SDS markdown manifest contains no document rows.")
    return rows


def render_ingestion_manifest(rows: list[IngestionManifestRow]) -> str:
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(["document_id", "s3_key", "markdown_path"])
    for row in rows:
        writer.writerow([row.document_id, row.s3_key, row.markdown_path])
    return stream.getvalue()


def safe_package_path(root: Path, relative: str) -> Path:
    destination = (root / relative).resolve()
    try:
        destination.relative_to(root.resolve())
    except ValueError as error:
        raise ValueError(f"Package path escapes output directory: {relative}") from error
    return destination


def select_ingestion_artifact(
    eligibility: dict[str, Any],
    baseline: str,
    ingestion: str,
    include_partial: bool,
) -> tuple[str, str]:
    status = eligibility.get("status")
    if status == "unsupported":
        raise ValueError(
            "unsupported document cannot be included in an ingestion package: "
            + ",".join(eligibility.get("reasonCodes", []))
        )
    if status == "partial" and not include_partial:
        raise ValueError(
            "partial document requires explicit --include-partial: "
            + ",".join(eligibility.get("reasonCodes", []))
        )
    artifact_name = eligibility.get("recommendedArtifact")
    if artifact_name == "baseline.md":
        content = baseline
    elif artifact_name == "ingestion.md":
        content = ingestion
    else:
        raise ValueError(f"unknown recommended artifact: {artifact_name}")
    if not content.strip():
        raise ValueError(f"recommended artifact is empty: {artifact_name}")
    return artifact_name, normalize_ingestion_whitespace(content)


def join_text(parts) -> str:
    text = " ".join(part.strip() for part in parts if part.strip())
    text = re.sub(r"\s+([,.;)])", r"\1", text)
    text = re.sub(r"([(])\s+", r"\1", text)
    return re.sub(r"\s+", " ", text).strip()


def colon_positions(word: PositionedWord) -> list[float]:
    positions: list[float] = []
    if not word.text:
        return positions
    width = max(word.right - word.left, 0.0)
    for index, character in enumerate(word.text):
        if character in COLON_CHARACTERS:
            positions.append(word.left + width * ((index + 0.5) / len(word.text)))
    return positions


def cluster_positions(positions: list[float], tolerance: float) -> list[list[float]]:
    if not positions:
        return []
    ordered = sorted(positions)
    clusters: list[list[float]] = [[ordered[0]]]
    for position in ordered[1:]:
        center = statistics.mean(clusters[-1])
        if abs(position - center) <= tolerance:
            clusters[-1].append(position)
        else:
            clusters.append([position])
    return clusters


def group_visual_lines(words: list[PositionedWord]) -> list[VisualLine]:
    if not words:
        return []
    median_height = statistics.median(max(word.height, 1.0) for word in words)
    tolerance = max(2.0, median_height * 0.55)
    lines: list[VisualLine] = []
    for word in sorted(words, key=lambda item: (item.center_y, item.left)):
        nearest = min(
            (
                (abs(line.center_y - word.center_y), line)
                for line in lines
                if abs(line.center_y - word.center_y) <= tolerance
                and min(line.bottom, word.bottom) - max(line.top, word.top)
                >= min(line.bottom - line.top, word.height) * 0.5
                and 0.5
                <= word.height / max(line.bottom - line.top, 1.0)
                <= 2.0
            ),
            default=None,
            key=lambda match: match[0],
        )
        if nearest is None:
            lines.append(VisualLine(words=[word]))
        else:
            nearest[1].words.append(word)
    for line in lines:
        line.words.sort(key=lambda item: item.left)
    return sorted(lines, key=lambda line: (line.center_y, line.left))


def split_line_at_colon(
    line: VisualLine,
    target_x: float,
    tolerance: float,
    left_bound: float,
    right_bound: float,
) -> tuple[str, str, float, float, float | None] | None:
    scoped_words = [
        word
        for word in line.words
        if left_bound <= (word.left + word.right) / 2 < right_bound
    ]
    candidates: list[tuple[float, PositionedWord, int, float]] = []
    for word in scoped_words:
        width = max(word.right - word.left, 0.0)
        for index, character in enumerate(word.text):
            if character not in COLON_CHARACTERS:
                continue
            position = word.left + width * ((index + 0.5) / max(len(word.text), 1))
            distance = abs(position - target_x)
            if distance <= tolerance:
                candidates.append((distance, word, index, position))
    if not candidates:
        return None

    _, separator_word, separator_index, separator_x = min(candidates, key=lambda item: item[0])
    left_parts: list[str] = []
    right_parts: list[str] = []
    found_separator = False
    for word in scoped_words:
        if word is separator_word:
            left_parts.append(word.text[:separator_index])
            right_parts.append(word.text[separator_index + 1 :])
            found_separator = True
        elif not found_separator:
            left_parts.append(word.text)
        else:
            right_parts.append(word.text)

    label = join_text(left_parts)
    value = join_text(right_parts)
    if not label:
        return None
    separator_suffix = separator_word.text[separator_index + 1 :].strip()
    value_left = separator_x if separator_suffix else next(
        (word.left for word in scoped_words if word.left > separator_word.right),
        None,
    )
    return label, value, separator_x, scoped_words[0].left, value_left


def recover_blocks_from_lines(
    page_number: int,
    lines: list[VisualLine],
    min_pairs: int,
) -> list[KeyValueBlock]:
    standalone_positions = sorted(
        position
        for line in lines
        for word in line.words
        if word.text.strip() in COLON_CHARACTERS
        for position in colon_positions(word)
    )
    all_positions = sorted(
        position
        for line in lines
        for word in line.words
        for position in colon_positions(word)
    )
    standalone_clusters = [
        cluster
        for cluster in cluster_positions(
            standalone_positions,
            COLON_CLUSTER_TOLERANCE,
        )
        if len(cluster) >= min_pairs
    ]
    all_clusters = [
        cluster
        for cluster in cluster_positions(all_positions, COLON_CLUSTER_TOLERANCE)
        if len(cluster) >= min_pairs
    ]
    standalone_centers = [statistics.mean(cluster) for cluster in standalone_clusters]
    cluster_specs = [
        (center, "explicit-colon-alignment") for center in standalone_centers
    ]
    cluster_specs.extend(
        (statistics.mean(cluster), "inline-colon-alignment")
        for cluster in all_clusters
        if all(
            abs(statistics.mean(cluster) - center) > COLON_CLUSTER_TOLERANCE
            for center in standalone_centers
        )
    )
    if not cluster_specs:
        return []

    median_height = statistics.median(
        max(line.bottom - line.top, 1.0) for line in lines
    )
    max_gap = median_height * 2.2
    blocks: list[KeyValueBlock] = []

    cluster_specs.sort(key=lambda item: item[0])
    cluster_centers = [center for center, _ in cluster_specs]
    for cluster_index, (cluster_x, confidence) in enumerate(cluster_specs):
        left_bound = (
            float("-inf")
            if cluster_index == 0
            else (cluster_centers[cluster_index - 1] + cluster_x) / 2
        )
        right_bound = (
            float("inf")
            if cluster_index == len(cluster_centers) - 1
            else (cluster_x + cluster_centers[cluster_index + 1]) / 2
        )
        current_rows: list[KeyValueRow] = []
        previous_line: VisualLine | None = None

        def flush() -> None:
            nonlocal current_rows
            usable_rows = [row for row in current_rows if row.value.strip()]
            if len(usable_rows) >= min_pairs:
                blocks.append(
                    KeyValueBlock(
                        page=page_number,
                        colon_x=round(cluster_x, 2),
                        rows=usable_rows,
                        confidence=confidence,
                    )
                )
            current_rows = []

        for line in lines:
            gap = line.top - previous_line.bottom if previous_line is not None else 0.0
            if previous_line is not None and gap > max_gap:
                flush()

            split = split_line_at_colon(
                line,
                target_x=cluster_x,
                tolerance=COLON_CLUSTER_TOLERANCE,
                left_bound=left_bound,
                right_bound=right_bound,
            )
            if split is not None:
                label, value, separator_x, label_left, value_left = split
                current_rows.append(
                    KeyValueRow(
                        label=label,
                        value=value,
                        top=round(line.top, 2),
                        bottom=round(line.bottom, 2),
                        colon_x=round(separator_x, 2),
                        label_left=round(label_left, 2),
                        value_left=round(value_left, 2) if value_left is not None else None,
                    )
                )
            elif current_rows and gap <= median_height * 1.1:
                continuation_words = [
                    word
                    for word in line.words
                    if left_bound <= (word.left + word.right) / 2 < right_bound
                ]
                if not continuation_words:
                    flush()
                    previous_line = line
                    continue
                continuation_left = min(word.left for word in continuation_words)
                continuation_right = max(word.right for word in continuation_words)
                continuation_text = join_text(word.text for word in continuation_words)
                previous_row = current_rows[-1]
                label_aligned = (
                    abs(continuation_left - previous_row.label_left) <= 12
                    and continuation_right < cluster_x - 3
                )
                value_aligned = (
                    previous_row.value_left is not None
                    and abs(continuation_left - previous_row.value_left) <= 12
                    and continuation_left > cluster_x + 3
                )
                if label_aligned:
                    previous_row.label = join_text(
                        [previous_row.label, continuation_text]
                    )
                    previous_row.bottom = round(line.bottom, 2)
                elif value_aligned:
                    previous_row.value = join_text(
                        [previous_row.value, continuation_text]
                    )
                    previous_row.bottom = round(line.bottom, 2)
                else:
                    flush()
            else:
                flush()
            previous_line = line
        flush()

    # A colon can fall into two close clusters on noisy pages. Deduplicate blocks by content.
    unique: dict[tuple[int, tuple[tuple[str, str], ...]], KeyValueBlock] = {}
    for block in blocks:
        key = (
            block.page,
            tuple((row.label, row.value) for row in block.rows),
        )
        unique[key] = block
    return sorted(unique.values(), key=lambda block: (block.page, block.rows[0].top))


def deduplicate_repeated_value(value: str) -> str:
    tokens = value.split()
    if len(tokens) >= 4 and len(tokens) % 2 == 0:
        midpoint = len(tokens) // 2
        if normalize_anchor(" ".join(tokens[:midpoint])) == normalize_anchor(
            " ".join(tokens[midpoint:])
        ):
            return " ".join(tokens[:midpoint])
    return value


def split_line_at_gaps(
    line: VisualLine,
    minimum_gap: float,
) -> list[tuple[str, str, float, float, float]]:
    words = sorted(line.words, key=lambda word: word.left)
    if len(words) < 2:
        return []
    splits = []
    large_gap_indices = [
        index
        for index in range(len(words) - 1)
        if words[index + 1].left - words[index].right >= minimum_gap
    ]
    for split_index in large_gap_indices:
        label_words = words[: split_index + 1]
        value_words = words[split_index + 1 :]
        label = join_text(word.text for word in label_words).rstrip(
            f" {COLON_CHARACTERS}"
        )
        value = deduplicate_repeated_value(
            join_text(word.text for word in value_words).lstrip(f" {COLON_CHARACTERS}")
        )
        if not label or not value or len(label) > 100 or len(value) > 300:
            continue
        value_left = value_words[0].left
        split_x = (label_words[-1].right + value_left) / 2
        splits.append((label, value, split_x, label_words[0].left, value_left))
    return splits


def split_line_at_gap(
    line: VisualLine,
    minimum_gap: float,
) -> tuple[str, str, float, float, float] | None:
    splits = split_line_at_gaps(line, minimum_gap)
    if not splits:
        return None
    return max(splits, key=lambda split: split[4] - split[2])


def recover_aligned_gap_blocks_from_lines(
    page_number: int,
    lines: list[VisualLine],
    min_pairs: int,
) -> list[KeyValueBlock]:
    if not lines:
        return []
    median_height = statistics.median(
        max(line.bottom - line.top, 1.0) for line in lines
    )
    candidates = []
    for line in lines:
        for split in split_line_at_gaps(
            line, minimum_gap=max(18.0, median_height * 2.0)
        ):
            candidates.append((line, *split))
    if len(candidates) < min_pairs:
        return []

    value_clusters = [
        cluster
        for cluster in cluster_positions(
            [candidate[5] for candidate in candidates],
            tolerance=12.0,
        )
        if len(cluster) >= min_pairs
    ]
    max_vertical_gap = median_height * 2.5
    blocks: list[KeyValueBlock] = []
    for cluster in value_clusters:
        value_left_center = statistics.mean(cluster)
        selected = [
            candidate
            for candidate in candidates
            if abs(candidate[5] - value_left_center) <= 12.0
        ]
        selected.sort(key=lambda candidate: candidate[0].center_y)
        current_rows: list[KeyValueRow] = []
        previous_line: VisualLine | None = None

        def flush() -> None:
            nonlocal current_rows
            if len(current_rows) >= min_pairs:
                blocks.append(
                    KeyValueBlock(
                        page=page_number,
                        colon_x=round(value_left_center, 2),
                        rows=current_rows,
                        confidence="aligned-gap",
                    )
                )
            current_rows = []

        line_positions = {id(source_line): index for index, source_line in enumerate(lines)}
        for selected_index, (
            line,
            label,
            value,
            split_x,
            label_left,
            value_left,
        ) in enumerate(selected):
            gap = line.top - previous_line.bottom if previous_line is not None else 0.0
            if previous_line is not None and gap > max_vertical_gap:
                flush()

            row_bottom = line.bottom
            if INCOMPLETE_LABEL_END.search(label.rstrip()):
                source_index = line_positions[id(line)]
                continuation = (
                    lines[source_index + 1]
                    if source_index + 1 < len(lines)
                    else None
                )
                next_selected_top = (
                    selected[selected_index + 1][0].top
                    if selected_index + 1 < len(selected)
                    else float("inf")
                )
                if (
                    continuation is not None
                    and continuation.top < next_selected_top
                    and continuation.top - line.bottom <= median_height * 1.1
                ):
                    continuation_words = sorted(
                        (
                            word
                            for word in continuation.words
                            if word.right < value_left_center - 3
                        ),
                        key=lambda word: word.left,
                    )
                    if continuation_words:
                        continuation_left = continuation_words[0].left
                        continuation_right = continuation_words[-1].right
                        if (
                            abs(continuation_left - label_left) <= 12
                            and continuation_right < value_left_center - 3
                        ):
                            label = join_text(
                                [
                                    label,
                                    join_text(word.text for word in continuation_words),
                                ]
                            )
                            row_bottom = continuation.bottom

            current_rows.append(
                KeyValueRow(
                    label=label,
                    value=value,
                    top=round(line.top, 2),
                    bottom=round(row_bottom, 2),
                    colon_x=round(split_x, 2),
                    label_left=round(label_left, 2),
                    value_left=round(value_left, 2),
                )
            )
            previous_line = line
        flush()

    unique: dict[tuple[int, tuple[tuple[str, str], ...]], KeyValueBlock] = {}
    for block in blocks:
        key = (
            block.page,
            tuple((row.label, row.value) for row in block.rows),
        )
        unique[key] = block
    return sorted(unique.values(), key=lambda block: (block.page, block.rows[0].top))


def deduplicate_blocks(blocks: list[KeyValueBlock]) -> list[KeyValueBlock]:
    unique: dict[tuple[int, tuple[tuple[str, str], ...]], KeyValueBlock] = {}
    for block in blocks:
        key = (
            block.page,
            tuple((row.label, row.value) for row in block.rows),
        )
        existing = unique.get(key)
        if existing is None or existing.confidence == "aligned-gap":
            unique[key] = block
    return sorted(unique.values(), key=lambda block: (block.page, block.rows[0].top))


def excluded_regions_from_page(page: Any) -> list[tuple[float, float, float, float]]:
    if page.size is None or page.predictions.layout is None:
        return []

    regions: list[tuple[float, float, float, float]] = []

    def visit(cluster: Any) -> None:
        label = getattr(cluster.label, "value", str(cluster.label))
        if label in {"table", "page_header", "page_footer"}:
            bbox = cluster.bbox.to_top_left_origin(page_height=page.size.height)
            regions.append((float(bbox.l), float(bbox.t), float(bbox.r), float(bbox.b)))
        for child in getattr(cluster, "children", []):
            visit(child)

    for cluster in page.predictions.layout.clusters:
        visit(cluster)
    return regions


def words_from_page(page: Any) -> list[PositionedWord]:
    if page.parsed_page is None or page.size is None:
        return []
    source_cells = page.parsed_page.word_cells
    if not source_cells:
        source_cells = page.parsed_page.textline_cells

    excluded_regions = excluded_regions_from_page(page)
    words: list[PositionedWord] = []
    for cell in source_cells:
        rect = cell.rect.to_top_left_origin(page_height=page.size.height)
        bbox = rect.to_bounding_box()
        center_x = (float(bbox.l) + float(bbox.r)) / 2
        center_y = (float(bbox.t) + float(bbox.b)) / 2
        if any(
            left <= center_x <= right and top <= center_y <= bottom
            for left, top, right, bottom in excluded_regions
        ):
            continue
        text = (getattr(cell, "orig", None) or cell.text).strip()
        if not text:
            continue
        words.append(
            PositionedWord(
                text=text,
                left=float(bbox.l),
                top=float(bbox.t),
                right=float(bbox.r),
                bottom=float(bbox.b),
            )
        )
    return words


def normalize_anchor(value: str) -> str:
    value = html.unescape(value)
    value = re.sub(r"<!--.*?-->", "", value)
    value = value.strip().strip("#*- ")
    value = value.strip(f"{COLON_CHARACTERS} ")
    value = re.sub(r"\bn\s*-\s*octanol\b", "noctanol", value, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", value).casefold()


@dataclass(frozen=True)
class VerifiedRowMatch:
    row: KeyValueRow
    label_line: int
    value_line: int
    source_lines: tuple[int, ...]
    mode: str


@dataclass(frozen=True)
class InsertionMatch:
    index: int
    range_end: int
    rows: list[VerifiedRowMatch]


def markdown_table(block: KeyValueBlock) -> str:
    def escape(value: str) -> str:
        value = html.escape(value, quote=False)
        return (
            value.replace("\\", "\\\\")
            .replace("|", "\\|")
            .replace("\n", " ")
            .strip()
        )

    lines = [
        "<!-- hybrid-key-value:start "
        f"page={block.page} confidence={block.confidence} partial={str(block.partial).lower()} "
        f"inserted_rows={len(block.inserted_labels)} detected_rows={len(block.rows)} -->",
        "| Property | Value |",
        "|---|---|",
    ]
    lines.extend(
        f"| {escape(row.label)} | {escape(row.value)} |"
        for row in block.rows
        if row.verified
    )
    lines.append("<!-- hybrid-key-value:end -->")
    return "\n".join(lines)


def find_wrapped_label_spans(
    markdown_lines: list[str],
    normalized_lines: list[str],
    target: str,
    start: int,
    end: int,
) -> list[tuple[int, ...]]:
    spans: list[tuple[int, ...]] = []
    for first in range(start, end):
        first_fragment = normalized_lines[first]
        if not first_fragment or not target.startswith(first_fragment):
            continue
        remaining = target[len(first_fragment) :].lstrip()
        selected = [first]
        for index in range(first + 1, min(end, first + 9)):
            if not remaining:
                break
            fragment = normalized_lines[index]
            visible_fragment = markdown_lines[index].strip().lstrip("#*: -")
            starts_new_heading = (
                bool(visible_fragment)
                and visible_fragment[0].isupper()
                and not visible_fragment.startswith("(")
            )
            if fragment and remaining.startswith(fragment) and not starts_new_heading:
                selected.append(index)
                remaining = remaining[len(fragment) :].lstrip()
                if len(selected) > 3:
                    break
        if not remaining and 1 < len(selected) <= 3:
            spans.append(tuple(selected))
    return spans


def find_insertion_match(
    markdown_lines: list[str],
    block: KeyValueBlock,
    occupied_ranges: list[tuple[int, int]],
) -> InsertionMatch | None:
    normalized_lines = [normalize_anchor(line) for line in markdown_lines]
    first_row = block.rows[0]
    first_label = normalize_anchor(first_row.label)
    first_inline_forms = {
        normalize_anchor(f"{first_row.label} : {first_row.value}"),
        normalize_anchor(f"{first_row.label} {first_row.value}"),
    }
    candidates = [
        index
        for index, line in enumerate(normalized_lines)
        if line == first_label or line in first_inline_forms
    ]
    # Without page markers, a repeated anchor is ambiguous and must stay report-only.
    if len(candidates) != 1:
        return None

    candidate = candidates[0]
    window_cap = min(len(markdown_lines), candidate + len(block.rows) * 5 + 30)
    next_heading = next(
        (
            index
            for index in range(candidate + 1, window_cap)
            if markdown_lines[index].lstrip().startswith("#")
        ),
        window_cap,
    )
    window_end = next_heading
    max_pair_distance = 30
    previous_label_index = candidate - 1
    value_cursor = candidate
    matches: list[VerifiedRowMatch] = []
    matched_indices: list[int] = []

    for row_index, row in enumerate(block.rows):
        label = normalize_anchor(row.label)
        value = normalize_anchor(row.value)
        if row.label.rstrip().endswith("-"):
            continue

        inline_forms = {
            normalize_anchor(f"{row.label} : {row.value}"),
            normalize_anchor(f"{row.label} {row.value}"),
        }
        inline_indices = [
            index
            for index in range(max(candidate, previous_label_index + 1), window_end)
            if normalized_lines[index] in inline_forms
        ]
        if len(inline_indices) == 1:
            inline_index = inline_indices[0]
            previous_label_index = inline_index
            value_cursor = max(value_cursor, inline_index + 1)
            matches.append(
                VerifiedRowMatch(
                    row=row,
                    label_line=inline_index,
                    value_line=inline_index,
                    source_lines=(inline_index,),
                    mode="inline-local",
                )
            )
            matched_indices.append(inline_index)
            continue

        label_indices = [
            index
            for index in range(candidate, window_end)
            if normalized_lines[index] == label
        ]
        label_span: tuple[int, ...] | None = None
        if len(label_indices) == 1:
            label_span = (label_indices[0],)
        elif not label_indices:
            wrapped_spans = find_wrapped_label_spans(
                markdown_lines,
                normalized_lines,
                target=label,
                start=candidate,
                end=window_end,
            )
            if len(wrapped_spans) == 1:
                label_span = wrapped_spans[0]
        label_index = label_span[0] if label_span is not None else None
        label_ordered = label_index is not None and label_index > previous_label_index
        if label_ordered:
            previous_label_index = label_index

        # Consume values for every coordinate row, including rows whose labels cannot be
        # anchored. This keeps repeated common values aligned with their source-row order
        # instead of allowing a later verified label to steal an earlier row's value.
        value_index = next(
            (
                index
                for index in range(value_cursor, window_end)
                if value and normalized_lines[index] == value
            ),
            None,
        )
        if value_index is not None:
            value_cursor = value_index + 1

        if (
            not label_ordered
            or value_index is None
            or abs(value_index - label_index) > max_pair_distance
        ):
            continue

        next_ordered_label = next(
            (
                normalize_anchor(later.label)
                for later in block.rows[row_index + 1 :]
                if normalize_anchor(later.label)
            ),
            None,
        )
        next_label_index = (
            next(
                (
                    index
                    for index in range(label_index + 1, window_end)
                    if normalized_lines[index] == next_ordered_label
                ),
                None,
            )
            if next_ordered_label is not None
            else None
        )
        mode = (
            "wrapped-label-local"
            if label_span is not None and len(label_span) > 1
            else (
                "interleaved-local"
                if value_index > label_index
                and (next_label_index is None or value_index < next_label_index)
                else "ordered-local"
            )
        )
        source_lines = tuple(sorted({*(label_span or ()), value_index}))
        matches.append(
            VerifiedRowMatch(
                row=row,
                label_line=label_index,
                value_line=value_index,
                source_lines=source_lines,
                mode=mode,
            )
        )
        matched_indices.extend(source_lines)

    if block.confidence == "aligned-gap" and len(matches) >= 2:
        matched_row_ids = {id(match.row) for match in matches}
        for row in block.rows:
            if id(row) in matched_row_ids or row.label.rstrip().endswith("-"):
                continue
            label = normalize_anchor(row.label)
            value = normalize_anchor(row.value)
            if not PHYSICAL_PROPERTY_LABEL.search(label):
                continue
            if label in {"property", "properties", "parameter"} or value in {
                "value",
                "values",
                "result",
                "remarks",
            }:
                continue
            label_candidates = [
                index
                for index in range(candidate, window_end)
                if normalized_lines[index] == label
                or normalized_lines[index].startswith(f"{label} ")
                or normalized_lines[index].endswith(f" {label}")
                or f" {label} " in normalized_lines[index]
            ]
            if len(label_candidates) != 1:
                continue
            label_index = label_candidates[0]
            matches.append(
                VerifiedRowMatch(
                    row=row,
                    label_line=label_index,
                    value_line=label_index,
                    source_lines=(),
                    mode="coordinate-grounded-unremoved",
                )
            )
            matched_indices.append(label_index)

    if len(matches) < 3:
        return None

    matched_range = (candidate, max(matched_indices) + 1)
    if any(
        matched_range[0] < occupied_end and occupied_start < matched_range[1]
        for occupied_start, occupied_end in occupied_ranges
    ):
        return None
    return InsertionMatch(
        index=matched_range[0],
        range_end=matched_range[1],
        rows=matches,
    )


def normalize_ingestion_whitespace(markdown: str) -> str:
    output: list[str] = []
    in_fence = False
    fence_marker: str | None = None
    previous_blank = False
    for line in markdown.splitlines():
        stripped = line.strip()
        if stripped.startswith(("```", "~~~")):
            marker = stripped[:3]
            if not in_fence:
                in_fence = True
                fence_marker = marker
            elif marker == fence_marker:
                in_fence = False
                fence_marker = None
        is_blank = not stripped
        if is_blank and not in_fence:
            if previous_blank:
                continue
            output.append("")
            previous_blank = True
            continue
        output.append(line)
        previous_blank = is_blank
    rendered = "\n".join(output).strip()
    return f"{rendered}\n" if rendered else ""


def _render_markdown(
    lines: list[str],
    insertions: list[tuple[int, str]],
    removed_lines: set[int],
) -> str:
    tables_by_index = {index: table for index, table in insertions}
    output: list[str] = []
    for index, line in enumerate(lines):
        if index in tables_by_index:
            output.extend((tables_by_index[index], ""))
        if index not in removed_lines:
            output.append(line)

    # Preserve every unmatched source line. The ingestion caller separately normalizes only
    # redundant blank runs after exact source deletion; nonblank source text stays byte-stable.
    rendered = "\n".join(output).rstrip()
    return f"{rendered}\n" if rendered else ""


def build_markdown_outputs(
    markdown: str,
    blocks: list[KeyValueBlock],
) -> tuple[str, str]:
    lines = markdown.splitlines()
    insertions: list[tuple[int, str]] = []
    removed_lines: set[int] = set()
    candidates = []
    for block in blocks:
        match = find_insertion_match(lines, block, occupied_ranges=[])
        if match is not None:
            candidates.append((block, match))
    candidates.sort(key=lambda candidate: (candidate[1].index, candidate[1].range_end))

    groups: list[list[tuple[KeyValueBlock, InsertionMatch]]] = []
    group_end = -1
    for candidate in candidates:
        match = candidate[1]
        if not groups or match.index >= group_end:
            groups.append([candidate])
            group_end = match.range_end
        else:
            groups[-1].append(candidate)
            group_end = max(group_end, match.range_end)

    for group in groups:
        primary_block, primary_match = max(
            group,
            key=lambda candidate: (
                len(candidate[1].rows),
                candidate[0].confidence != "aligned-gap",
            ),
        )
        selected: list[VerifiedRowMatch] = []
        pair_keys: set[tuple[str, str]] = set()
        selected_labels: dict[str, str] = {}
        used_source_lines: set[int] = set()
        merged_modes = {primary_block.confidence}

        row_pool = [
            (source_block, matched)
            for source_block, match in group
            for matched in match.rows
        ]
        row_pool.sort(
            key=lambda candidate: (
                len(candidate[1].source_lines),
                len(normalize_anchor(candidate[1].row.label)),
                candidate[0].confidence != "aligned-gap",
            ),
            reverse=True,
        )
        for source_block, matched in row_pool:
            label_key = normalize_anchor(matched.row.label)
            value_key = normalize_anchor(matched.row.value)
            pair_key = (label_key, value_key)
            if pair_key in pair_keys:
                continue
            if label_key in selected_labels and selected_labels[label_key] != value_key:
                continue
            if used_source_lines.intersection(matched.source_lines):
                continue
            if source_block is not primary_block:
                copied_row = replace(matched.row, source_lines=[])
                matched = replace(matched, row=copied_row)
                primary_block.rows.append(copied_row)
                merged_modes.add(source_block.confidence)
            selected.append(matched)
            pair_keys.add(pair_key)
            selected_labels[label_key] = value_key
            used_source_lines.update(matched.source_lines)

        selected.sort(
            key=lambda matched: (
                min(matched.source_lines)
                if matched.source_lines
                else matched.label_line
            )
        )
        primary_block.rows.sort(key=lambda row: (row.top, row.label))
        primary_block.inserted = True
        primary_block.insertion_anchor = lines[primary_match.index]
        primary_block.inserted_labels = [matched.row.label for matched in selected]
        primary_block.omitted_labels = [
            row.label
            for row in primary_block.rows
            if row.label not in primary_block.inserted_labels
        ]
        primary_block.partial = len(selected) != len(primary_block.rows)
        if len(merged_modes) > 1:
            primary_block.confidence = "merged-coordinate-evidence"
        for matched in selected:
            matched.row.verified = True
            matched.row.label_line = matched.label_line + 1
            matched.row.value_line = matched.value_line + 1
            matched.row.verification_mode = matched.mode
            matched.row.source_lines = [index + 1 for index in matched.source_lines]
            removed_lines.update(matched.source_lines)
        insertions.append((primary_match.index, markdown_table(primary_block)))

    hybrid = _render_markdown(lines, insertions, removed_lines=set())
    ingestion = normalize_ingestion_whitespace(
        _render_markdown(lines, insertions, removed_lines=removed_lines)
    )
    return hybrid, ingestion


def augment_markdown(markdown: str, blocks: list[KeyValueBlock]) -> str:
    """Backward-compatible additive output used by focused helper tests."""
    hybrid, _ = build_markdown_outputs(markdown, blocks)
    return hybrid


def has_structured_section_nine_table(markdown: str) -> bool:
    lines = markdown.splitlines()
    in_section_nine = False
    for index, line in enumerate(lines):
        heading = normalize_anchor(line)
        if re.match(r"(?:section )?9(?:\D|$)", heading) and "physical" in heading:
            in_section_nine = True
            continue
        if in_section_nine and re.match(r"(?:section )?10(?:\D|$)", heading):
            return False
        if (
            in_section_nine
            and line.startswith("|")
            and index + 1 < len(lines)
            and re.fullmatch(r"\|(?:\s*:?-{3,}:?\s*\|)+", lines[index + 1])
        ):
            return True
    return False


def determine_eligibility(
    baseline: str,
    blocks: list[KeyValueBlock],
    native_word_count: int,
) -> dict[str, Any]:
    inserted = [block for block in blocks if block.inserted]
    if native_word_count == 0 or len(normalize_anchor(baseline)) < 200:
        return {
            "status": "unsupported",
            "reasonCodes": ["no-native-text"],
            "ingestionAllowed": False,
            "recommendedArtifact": "baseline.md",
        }
    if not inserted and has_structured_section_nine_table(baseline):
        return {
            "status": "eligible",
            "reasonCodes": ["structured-section-9-table"],
            "ingestionAllowed": True,
            "recommendedArtifact": "baseline.md",
        }
    if not blocks:
        return {
            "status": "unsupported",
            "reasonCodes": ["unsupported-layout"],
            "ingestionAllowed": False,
            "recommendedArtifact": "baseline.md",
        }
    if not inserted:
        return {
            "status": "unsupported",
            "reasonCodes": ["no-verified-blocks"],
            "ingestionAllowed": False,
            "recommendedArtifact": "baseline.md",
        }

    reason_codes = []
    verified_rows = sum(row.verified for block in inserted for row in block.rows)
    if verified_rows < 10:
        reason_codes.append("insufficient-verified-rows")
    if any(block.partial for block in inserted):
        reason_codes.append("partial-blocks")
    if len(inserted) != len(blocks):
        reason_codes.append("rejected-blocks")
    if reason_codes:
        return {
            "status": "partial",
            "reasonCodes": reason_codes,
            "ingestionAllowed": False,
            "recommendedArtifact": "ingestion.md",
        }
    return {
        "status": "eligible",
        "reasonCodes": ["all-detected-blocks-verified"],
        "ingestionAllowed": True,
        "recommendedArtifact": "ingestion.md",
    }


def atomic_write_set(outputs: dict[Path, str]) -> None:
    temporary_paths: dict[Path, Path] = {}
    try:
        for destination, content in outputs.items():
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_name(f".{destination.name}.tmp")
            temporary.write_text(content, encoding="utf-8")
            temporary_paths[destination] = temporary
        for destination, temporary in temporary_paths.items():
            temporary.replace(destination)
    finally:
        for temporary in temporary_paths.values():
            temporary.unlink(missing_ok=True)


def build_converter():
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import (
        HeadingHierarchyOptions,
        PdfPipelineOptions,
        TableFormerMode,
    )
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions(
        do_ocr=False,
        do_table_structure=True,
        force_backend_text=True,
        generate_parsed_pages=True,
        generate_page_images=False,
        generate_picture_images=False,
        heading_hierarchy_options=HeadingHierarchyOptions(
            enabled=True,
            use_bookmarks=True,
            use_numbering=True,
            use_style=False,
            max_level=4,
        ),
        document_timeout=300,
    )
    options.table_structure_options.mode = TableFormerMode.ACCURATE
    options.table_structure_options.do_cell_matching = True
    return DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=options),
        }
    )


def main() -> int:
    args = parse_args()
    input_dir = args.input_dir.resolve()
    output_dir = args.output_dir.resolve()
    if not input_dir.is_dir():
        print(f"Input directory does not exist: {input_dir}", file=sys.stderr)
        return 1

    manifest_rows: list[IngestionManifestRow] | None = None
    manifest_by_pdf: dict[Path, IngestionManifestRow] = {}
    package_outputs: dict[Path, str] = {}
    package_artifacts_root: Path | None = None
    if args.ingestion_manifest is not None:
        try:
            manifest_rows = parse_ingestion_manifest(
                args.ingestion_manifest.read_text(encoding="utf-8-sig")
            )
            pdf_paths = []
            for row in manifest_rows:
                pdf_path = safe_package_path(input_dir, row.s3_key)
                if not pdf_path.is_file():
                    raise ValueError(
                        f"manifest PDF does not exist below --input-dir: {row.s3_key}"
                    )
                pdf_paths.append(pdf_path)
                manifest_by_pdf[pdf_path] = row
            if output_dir == input_dir:
                raise ValueError("--output-dir must differ from --input-dir")
            if output_dir.exists():
                if not args.force and any(output_dir.iterdir()):
                    raise ValueError(
                        "ingestion package output directory is not empty; use --force"
                    )
                shutil.rmtree(output_dir)
            package_artifacts_root = output_dir.with_name(
                f"{output_dir.name}.artifacts"
            )
        except (OSError, ValueError) as error:
            print(f"Invalid ingestion manifest: {error}", file=sys.stderr)
            return 1
    else:
        pdf_paths = sorted(
            path
            for path in input_dir.rglob("*")
            if path.is_file() and path.suffix.lower() == ".pdf"
        )

    if not pdf_paths:
        print(f"No PDF files found under {input_dir}", file=sys.stderr)
        return 1

    converter = build_converter()
    print(f"docling_version={version('docling')}")
    print("profile=hybrid-native-coordinate-v4")

    converted = failed = skipped = 0
    for index, pdf_path in enumerate(pdf_paths, start=1):
        row = manifest_by_pdf.get(pdf_path)
        relative = Path(row.s3_key) if row is not None else pdf_path.relative_to(input_dir)
        artifacts_root = (
            package_artifacts_root if row is not None else output_dir
        )
        assert artifacts_root is not None
        document_dir = artifacts_root / relative.with_suffix("")
        hybrid_path = document_dir / "hybrid.md"
        ingestion_path = document_dir / "ingestion.md"
        baseline_path = document_dir / "baseline.md"
        report_path = document_dir / "key-values.json"
        expected_outputs = (hybrid_path, ingestion_path, baseline_path, report_path)
        already_converted = not args.force and all(
            path.exists() and path.stat().st_size > 0 for path in expected_outputs
        )

        started = time.monotonic()
        try:
            if already_converted:
                baseline = baseline_path.read_text(encoding="utf-8")
                ingestion = ingestion_path.read_text(encoding="utf-8")
                eligibility = json.loads(report_path.read_text(encoding="utf-8"))[
                    "eligibility"
                ]
                print(f"[{index}/{len(pdf_paths)}] {relative}: already converted")
                skipped += 1
            else:
                result = converter.convert(str(pdf_path))
                baseline = result.document.export_to_markdown()
                blocks: list[KeyValueBlock] = []
                native_word_count = 0
                for page in result.pages:
                    words = words_from_page(page)
                    native_word_count += len(words)
                    lines = group_visual_lines(words)
                    blocks.extend(
                        recover_blocks_from_lines(
                            page_number=page.page_no,
                            lines=lines,
                            min_pairs=args.min_pairs,
                        )
                    )
                    blocks.extend(
                        recover_aligned_gap_blocks_from_lines(
                            page_number=page.page_no,
                            lines=lines,
                            min_pairs=args.min_pairs,
                        )
                    )
                blocks = deduplicate_blocks(blocks)
                hybrid, ingestion = build_markdown_outputs(baseline, blocks)
                eligibility = determine_eligibility(
                    baseline=baseline,
                    blocks=blocks,
                    native_word_count=native_word_count,
                )

                report = (
                    json.dumps(
                        {
                            "source": str(pdf_path),
                            "profile": "hybrid-native-coordinate-v4",
                            "docling_version": version("docling"),
                            "eligibility": eligibility,
                            "duplicate_strategy": {
                                "hybrid.md": "preserve-flattened-source",
                                "ingestion.md": "remove-exact-verified-label-value-lines",
                            },
                            "output_stats": {
                                "baseline_characters": len(baseline),
                                "native_word_count": native_word_count,
                                "hybrid_characters": len(hybrid),
                                "ingestion_characters": len(ingestion),
                                "inserted_blocks": sum(
                                    block.inserted for block in blocks
                                ),
                                "verified_rows": sum(
                                    row.verified
                                    for block in blocks
                                    for row in block.rows
                                ),
                                "partial_blocks": sum(
                                    block.inserted and block.partial for block in blocks
                                ),
                            },
                            "blocks": [asdict(block) for block in blocks],
                        },
                        ensure_ascii=False,
                        indent=2,
                    )
                    + "\n"
                )
                atomic_write_set(
                    {
                        hybrid_path: hybrid,
                        ingestion_path: ingestion,
                        baseline_path: baseline,
                        report_path: report,
                    }
                )
                elapsed = time.monotonic() - started
                inserted = sum(block.inserted for block in blocks)
                print(
                    f"[{index}/{len(pdf_paths)}] {relative}: "
                    f"{len(blocks)} blocks ({inserted} inserted), "
                    f"{len(hybrid)} chars in {elapsed:.1f}s"
                )
                converted += 1

            if row is not None:
                artifact_name, package_markdown = select_ingestion_artifact(
                    eligibility,
                    baseline,
                    ingestion,
                    include_partial=args.include_partial,
                )
                package_path = safe_package_path(output_dir, row.markdown_path)
                package_outputs[package_path] = package_markdown
                print(
                    f"  package {row.markdown_path} <- {artifact_name} "
                    f"({eligibility['status']})"
                )
        except Exception as error:  # noqa: BLE001 - one bad PDF must not end the batch
            print(f"[{index}/{len(pdf_paths)}] {relative}: FAILED {error}", file=sys.stderr)
            error_path = hybrid_path.with_suffix(".error.txt")
            error_path.parent.mkdir(parents=True, exist_ok=True)
            error_path.write_text(str(error), encoding="utf-8")
            failed += 1

    if manifest_rows is not None and failed == 0:
        package_outputs[output_dir / "manifest.csv"] = render_ingestion_manifest(
            manifest_rows
        )
        atomic_write_set(package_outputs)
        print(
            f"ingestion_package={len(manifest_rows)} markdown objects + manifest.csv"
        )

    print(
        f"\nconverted={converted} skipped={skipped} failed={failed} -> {output_dir}"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
