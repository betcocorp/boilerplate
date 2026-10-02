#!/usr/bin/env python3
"""Freeze a heterogeneous SDS benchmark from direct Poppler layout text evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

SECTION_9 = re.compile(r"^\s*(?:section\s+)?9(?:\s|[.:[\]–—-])+.*physical", re.I)
SECTION_10 = re.compile(r"^\s*(?:section\s+)?10(?:\s|[.:[\]–—-])+", re.I)
COLON_PAIR = re.compile(r"^\s*(.{2,100}?)\s*[:：]\s+(\S.*?)\s*$")
CRITICAL_LABEL = re.compile(
    r"(?:^|\b)(?:ph|flash\s*point|flammab\w*|explosi\w*|auto.?ignition)(?:\b|$)",
    re.I,
)
EXCLUDED_LABEL = re.compile(
    r"^(?:page|version|revision|date|safety data sheet|product name|product code|section)\b",
    re.I,
)
INCOMPLETE_LABEL = re.compile(
    r"(?:n-|initial\s+boiling|explosive|explosion|upper|lower|boiling|coefficient)$",
    re.I,
)
PROPERTY_LABEL = re.compile(
    r"(?:appearance|physical\s+state|^form$|colou?r|odou?r|threshold|^ph(?:\s|$)|"
    r"melting|freezing|boiling|flash\s*point|evaporation|flammab|explosi|"
    r"vapo[u]?r|relative\s+density|specific\s+gravity|density|solubility|"
    r"partition\s+coefficient|auto.?ignition|decomposition|viscosity|"
    r"particle\s+size|molecular\s+(?:weight|formula)|oxidizing|explosive\s+properties|"
    r"pour\s+point|flow\s+time)",
    re.I,
)
GOLDEN_PDFS = {
    "dump/sds/Finished Good SDS/Push (Mint)_M000133.pdf",
    "dump/sds/Basic SDS/Chemtrec SDS files ready to transfer/1664 – StreetShoe NXT Gloss SDS English.pdf",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-pairs", type=int, default=750)
    parser.add_argument("--max-documents", type=int, default=80)
    parser.add_argument("--scanned-controls", type=int, default=5)
    parser.add_argument("--max-attempts", type=int, default=1600)
    parser.add_argument("--check", action="store_true")
    return parser.parse_args()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def category(relative: str) -> str:
    top_level = Path(relative).parts[2]
    known = {
        "Finished Good SDS": "finished-good",
        "Basic SDS": "basic",
        "Raw Materials SDS": "raw-material",
        "Private label SDS": "private-label",
        "Betco SDS": "betco-archive",
        "EnviroZyme SDS": "envirozyme",
        "Intermediate (premix) SDS": "intermediate",
    }
    if top_level in known:
        return known[top_level]
    return re.sub(r"[^a-z0-9]+", "-", top_level.casefold()).strip("-")


def family(relative: str) -> str:
    name = Path(relative).stem
    if category(relative) == "basic":
        parts = Path(relative).parts
        return "/".join(parts[2:5])
    suffix = name.rsplit("_", 1)[-1]
    suffix = re.sub(r"\s*\([^)]*\)\s*$", "", suffix)
    suffix = re.sub(r"[^a-z0-9]+", "-", suffix.casefold()).strip("-")
    return suffix or name.casefold()


def extract_text(pdf: Path) -> str:
    completed = subprocess.run(
        ["pdftotext", "-layout", str(pdf), "-"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return completed.stdout.decode("utf-8", errors="replace")


def normalize(value: str) -> str:
    return " ".join(value.casefold().split())


def clean_direct_value(label: str, value: str) -> str | None:
    tokens = value.split()
    if len(tokens) >= 4 and len(tokens) % 2 == 0:
        midpoint = len(tokens) // 2
        if normalize(" ".join(tokens[:midpoint])) == normalize(" ".join(tokens[midpoint:])):
            value = " ".join(tokens[:midpoint])
    if re.search(r"\b(?:appearance|physical state|odou?r|vapo[u]?r pressure)\b", value, re.I):
        return None
    return value


def parse_pair(line: str) -> tuple[str, str, int] | None:
    colon_separators = list(re.finditer(r"(?:\s+[:：]\s+|[:：]\s{2,})", line))
    if colon_separators:
        separator = colon_separators[-1]
        label = line[: separator.start()].strip()
        value = line[separator.end() :].strip()
        value_column = separator.end()
    else:
        leading = len(line) - len(line.lstrip())
        stripped = line.strip()
        separator_runs = list(re.finditer(r"\s{3,}", stripped))
        if not separator_runs or separator_runs[0].end() - separator_runs[0].start() > 60:
            return None
        parts = [part.strip() for part in re.split(r"\s{3,}", stripped) if part.strip()]
        if len(parts) < 2:
            return None
        label, value = parts[0], " ".join(parts[1:])
        value_column = leading + separator_runs[0].end()
    label = " ".join(label.split()).strip()
    label = re.sub(r"^[\-–—•·]+\s*", "", label)
    value = " ".join(value.split())
    value = clean_direct_value(label, value)
    if value is None:
        return None
    if (
        not 2 <= len(label) <= 100
        or not 1 <= len(value) <= 300
        or EXCLUDED_LABEL.search(label)
        or not PROPERTY_LABEL.search(label)
        or not re.search(r"[A-Za-zÀ-ÖØ-öø-ÿ0-9]", value)
        or label.isnumeric()
        or (value.isnumeric() and len(value) <= 3 and label.isupper() and len(label) > 8)
        or not re.search(r"[A-Za-zÀ-ÖØ-öø-ÿ]", label)
    ):
        return None
    return label, value, value_column


def section_9_pairs(text: str) -> tuple[list[dict], list[int]]:
    pairs: list[dict] = []
    section_pages: set[int] = set()
    seen: set[tuple[str, str]] = set()
    in_section = False
    for page_number, page in enumerate(text.split("\f"), start=1):
        lines = page.splitlines()
        index = 0
        while index < len(lines):
            line = lines[index]
            line_number = index + 1
            if SECTION_9.search(line):
                in_section = True
                section_pages.add(page_number)
                index += 1
                continue
            if in_section and SECTION_10.search(line):
                in_section = False
                index += 1
                continue
            if not in_section:
                index += 1
                continue
            section_pages.add(page_number)
            parsed = parse_pair(line)
            if parsed is None:
                index += 1
                continue
            label, value, value_column = parsed
            if INCOMPLETE_LABEL.search(label):
                index += 1
                continue
            evidence_lines = [line.strip()]
            next_index = index + 1
            while next_index < len(lines):
                continuation = lines[next_index]
                if (
                    not continuation.strip()
                    or SECTION_10.search(continuation)
                    or re.fullmatch(r"\s*\d+\s*/\s*\d+\s*", continuation)
                ):
                    break
                if parse_pair(continuation) is not None:
                    break
                indentation = len(continuation) - len(continuation.lstrip())
                if indentation < max(0, value_column - 3):
                    break
                fragment = " ".join(continuation.split()).strip("-–—•· ")
                value = f"{value} {fragment}"
                evidence_lines.append(continuation.strip())
                next_index += 1
            key = (normalize(label), normalize(value))
            if key not in seen:
                seen.add(key)
                pairs.append(
                    {
                        "label": label,
                        "value": value,
                        "critical": bool(CRITICAL_LABEL.search(label)),
                        "evidence": {
                            "method": "pdftotext-layout-explicit-v1",
                            "page": page_number,
                            "line": line_number,
                            "lineEnd": next_index,
                            "text": "\n".join(evidence_lines),
                        },
                    }
                )
            index = max(index + 1, next_index)
    return pairs, sorted(section_pages)


def select_documents(workspace_root: Path, args: argparse.Namespace) -> tuple[list[dict], list[dict]]:
    pdf_root = workspace_root / "dump/sds"
    candidates = []
    for pdf in pdf_root.rglob("*.pdf"):
        relative = pdf.relative_to(workspace_root).as_posix()
        if relative in GOLDEN_PDFS:
            continue
        rank = hashlib.sha256(relative.encode()).hexdigest()
        candidates.append((rank, pdf, relative, category(relative), family(relative)))
    candidates.sort(key=lambda item: item[0])

    positives: list[dict] = []
    controls: list[dict] = []
    selected_families: set[tuple[str, str]] = set()
    attempts = 0
    pair_total = 0
    selected_category_counts: dict[str, int] = {}
    for _, pdf, relative, document_category, document_family in candidates:
        if attempts >= args.max_attempts or len(positives) >= args.max_documents:
            break
        family_key = (document_category, document_family)
        if family_key in selected_families:
            continue
        category_limit = (
            4
            if document_category == "finished-good"
            else 15
            if document_category == "raw-material"
            else 10
        )
        if selected_category_counts.get(document_category, 0) >= category_limit:
            continue
        attempts += 1
        try:
            text = extract_text(pdf)
        except subprocess.CalledProcessError:
            continue
        native_characters = len(text.strip())
        if native_characters < 500:
            if len(controls) < args.scanned_controls:
                controls.append(
                    {
                        "localPdfPath": relative,
                        "pdfSha256": sha256(pdf),
                        "pdfBytes": pdf.stat().st_size,
                        "category": document_category,
                        "family": document_family,
                        "nativeTextCharacters": native_characters,
                    }
                )
                selected_families.add(family_key)
                selected_category_counts[document_category] = (
                    selected_category_counts.get(document_category, 0) + 1
                )
            continue
        pairs, pages = section_9_pairs(text)
        if len(pairs) < 8:
            continue
        positives.append(
            {
                "localPdfPath": relative,
                "sourceSuffix": relative.removeprefix("dump/sds/"),
                "pdfSha256": sha256(pdf),
                "pdfBytes": pdf.stat().st_size,
                "category": document_category,
                "family": document_family,
                "nativeTextCharacters": native_characters,
                "section9Pages": pages,
                "expectedPairs": pairs,
            }
        )
        selected_families.add(family_key)
        pair_total += len(pairs)
        selected_category_counts[document_category] = (
            selected_category_counts.get(document_category, 0) + 1
        )
        if pair_total >= args.target_pairs and len(controls) >= args.scanned_controls:
            break
    if pair_total < args.target_pairs:
        raise RuntimeError(
            f"Only found {pair_total} explicit pairs after {attempts} extraction attempts"
        )
    if len(controls) < args.scanned_controls:
        raise RuntimeError(f"Only found {len(controls)} scanned controls")
    return positives, controls


def render_outputs(positives: list[dict], controls: list[dict]) -> tuple[str, str]:
    manifest_documents = []
    truth_documents = []
    for document in positives:
        manifest_documents.append(
            {key: value for key, value in document.items() if key != "expectedPairs"}
            | {"expectedPairCount": len(document["expectedPairs"])}
        )
        truth_documents.append(
            {
                "source_suffix": document["sourceSuffix"],
                "allowed_eligibility_statuses": ["eligible", "partial"],
                "exclude_from_pair_coverage": False,
                "scopes": [
                    {
                        "name": "section-9-source-explicit",
                        "evidence_level": "direct-source",
                        "include_all_actual": False,
                        "pages": document["section9Pages"],
                        "expected": document["expectedPairs"],
                        "optional": [],
                        "forbidden": [],
                    }
                ],
            }
        )
    for control in controls:
        source_suffix = control["localPdfPath"].removeprefix("dump/sds/")
        manifest_documents.append(control | {"role": "scanned-control", "expectedPairCount": 0})
        truth_documents.append(
            {
                "source_suffix": source_suffix,
                "allowed_eligibility_statuses": ["unsupported"],
                "exclude_from_pair_coverage": True,
                "scopes": [],
            }
        )

    category_counts: dict[str, int] = {}
    for document in manifest_documents:
        category_counts[document["category"]] = category_counts.get(document["category"], 0) + 1
    manifest = {
        "schema": "sds-expanded-benchmark/v2",
        "benchmarkId": "heterogeneous-section9-ingestion-availability-v2",
        "selection": {
            "method": "sha256-ranked unique-family sampling",
            "groundTruth": "Direct label/value evidence from Poppler pdftotext -layout within Section 9; independent of Docling and the hybrid converter. Ambiguous property-header values, duplicated column values, incomplete labels, and ingredient-table rows are excluded.",
            "availabilitySemantics": "A pair passes when it remains explicitly associated in baseline Markdown or is emitted as a verified hybrid recovery row; hybrid precision is scored only from emitted recovery rows.",
            "goldenBenchmarkDocumentsExcluded": sorted(GOLDEN_PDFS),
        },
        "summary": {
            "positiveDocuments": len(positives),
            "scannedControls": len(controls),
            "expectedPairs": sum(len(document["expectedPairs"]) for document in positives),
            "criticalExpectedPairs": sum(
                pair["critical"]
                for document in positives
                for pair in document["expectedPairs"]
            ),
            "categoryCounts": dict(sorted(category_counts.items())),
        },
        "documents": manifest_documents,
    }
    truth = {
        "schema": "sds-hybrid-ground-truth/v2",
        "benchmarkId": manifest["benchmarkId"],
        "documents": truth_documents,
    }
    return (
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        json.dumps(truth, ensure_ascii=False, indent=2) + "\n",
    )


def main() -> int:
    args = parse_args()
    repository_root = Path(__file__).resolve().parents[2]
    workspace_root = repository_root.parents[1]
    fixtures = repository_root / "scripts/docling/fixtures"
    manifest_path = fixtures / "sds-expanded-benchmark-v2.json"
    truth_path = fixtures / "sds-expanded-benchmark-ground-truth-v2.json"
    positives, controls = select_documents(workspace_root, args)
    manifest, truth = render_outputs(positives, controls)
    if args.check:
        if manifest_path.read_text(encoding="utf-8") != manifest:
            raise RuntimeError("Expanded benchmark manifest differs from frozen output")
        if truth_path.read_text(encoding="utf-8") != truth:
            raise RuntimeError("Expanded benchmark ground truth differs from frozen output")
        print(
            f"verified {len(positives)} documents and "
            f"{sum(len(document['expectedPairs']) for document in positives)} pairs"
        )
        return 0
    manifest_path.write_text(manifest, encoding="utf-8")
    truth_path.write_text(truth, encoding="utf-8")
    print(
        f"froze {len(positives)} documents, {len(controls)} controls, and "
        f"{sum(len(document['expectedPairs']) for document in positives)} pairs"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
