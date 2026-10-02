#!/usr/bin/env python3
"""Score hybrid recovery, eligibility, source preservation, and promotion gates."""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Pair:
    label: str
    value: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--ground-truth", required=True, type=Path)
    parser.add_argument("--gates", type=Path)
    parser.add_argument("--json-output", type=Path)
    parser.add_argument("--min-precision", type=float, default=1.0)
    parser.add_argument("--min-recall", type=float, default=0.0)
    args = parser.parse_args()
    for name in ("min_precision", "min_recall"):
        value = getattr(args, name)
        if not 0 <= value <= 1:
            parser.error(f"--{name.replace('_', '-')} must be between 0 and 1")
    return args


def normalize(value: str) -> str:
    value = value.translate(str.maketrans({"–": "-", "—": "-", "−": "-"}))
    value = " ".join(value.casefold().split())
    value = re.sub(r"\s*([/()-])\s*", r"\1", value)
    return value


def as_pair(raw: dict[str, Any]) -> Pair:
    return Pair(normalize(str(raw["label"])), normalize(str(raw["value"])))


def load_actual(report: dict) -> list[tuple[int, Pair]]:
    actual: list[tuple[int, Pair]] = []
    for block in report.get("blocks", []):
        if not block.get("inserted"):
            continue
        for row in block.get("rows", []):
            if row.get("verified"):
                actual.append((block["page"], as_pair(row)))
    return actual


def serialize_pairs(pairs: set[Pair]) -> list[dict[str, str]]:
    return [
        {"label": pair.label, "value": pair.value}
        for pair in sorted(pairs, key=lambda pair: (pair.label, pair.value))
    ]


def normalize_markdown_line(line: str) -> str:
    line = re.sub(r"<!--.*?-->", "", line)
    line = line.replace("\\_", "_").strip().strip("#*-•· ")
    return normalize(line)


def baseline_pair_available(markdown: str, pair: Pair) -> bool:
    raw_lines = markdown.splitlines()
    normalized_lines = [normalize_markdown_line(line) for line in raw_lines]
    label = pair.label.rstrip(":")
    value = pair.value
    nonempty = [line for line in normalized_lines if line]
    for raw_line, line in zip(raw_lines, normalized_lines, strict=True):
        if not line:
            continue
        if raw_line.strip().startswith("|") and label in line and value in line:
            return True
        if line.startswith(label):
            remainder = line[len(label) :].lstrip(" :")
            if remainder == value:
                return True
    for index, line in enumerate(nonempty[:-1]):
        if line.rstrip(": ") == label and nonempty[index + 1].lstrip(": ") == value:
            return True
    return False


def score_scope(
    actual: list[tuple[int, Pair]], scope: dict, baseline_markdown: str = ""
) -> dict:
    pages = set(scope["pages"])
    expected_raw = scope.get("expected", [])
    expected = {as_pair(pair) for pair in expected_raw}
    optional = {as_pair(pair) for pair in scope.get("optional", [])}
    forbidden_raw = scope.get("forbidden", [])
    forbidden = {as_pair(pair) for pair in forbidden_raw}
    critical_expected = {
        as_pair(pair) for pair in expected_raw if pair.get("critical", False)
    }
    critical_labels = {
        as_pair(pair).label
        for pair in [*expected_raw, *forbidden_raw]
        if pair.get("critical", False)
    }
    evaluated_labels = {pair.label for pair in expected | optional | forbidden}
    scoped_actual = [
        pair
        for page, pair in actual
        if page in pages
        and (scope.get("include_all_actual", False) or pair.label in evaluated_labels)
    ]
    actual_set = set(scoped_actual)
    recovered_true_positives = actual_set & expected
    baseline_true_positives = {
        pair for pair in expected if baseline_pair_available(baseline_markdown, pair)
    }
    true_positives = recovered_true_positives | baseline_true_positives
    false_positives = {
        pair for pair in actual_set if pair not in expected and pair not in optional
    }
    false_positives |= actual_set & forbidden
    false_negatives = expected - true_positives
    duplicate_count = len(scoped_actual) - len(actual_set)
    critical_false_positives = {
        pair for pair in false_positives if pair.label in critical_labels
    }
    critical_true_positives = true_positives & critical_expected
    critical_false_negatives = critical_expected - true_positives
    precision_denominator = (
        len(recovered_true_positives) + len(false_positives) + duplicate_count
    )
    precision = (
        len(recovered_true_positives) / precision_denominator
        if precision_denominator
        else 1.0
    )
    recall = len(true_positives) / len(expected) if expected else 1.0
    return {
        "name": scope["name"],
        "coverage_mode": (
            "all-actual-on-pages"
            if scope.get("include_all_actual", False)
            else "annotated-labels-only"
        ),
        "pages": sorted(pages),
        "expected": len(expected),
        "actual_scoped": len(scoped_actual),
        "true_positives": len(true_positives),
        "recovered_true_positives": len(recovered_true_positives),
        "baseline_true_positives": len(baseline_true_positives),
        "false_positives": serialize_pairs(false_positives),
        "critical_expected": len(critical_expected),
        "critical_true_positives": len(critical_true_positives),
        "critical_false_positives": serialize_pairs(critical_false_positives),
        "critical_false_negatives": serialize_pairs(critical_false_negatives),
        "false_negatives": serialize_pairs(false_negatives),
        "duplicates": duplicate_count,
        "precision": precision,
        "recall": recall,
    }


def markdown_tables(text: str) -> list[str]:
    separator = re.compile(r"^\|(?:\s*:?-{3,}:?\s*\|)+$")
    lines = text.splitlines()
    tables: list[str] = []
    index = 0
    while index < len(lines) - 1:
        if (
            lines[index].startswith("|")
            and lines[index].endswith("|")
            and separator.fullmatch(lines[index + 1])
        ):
            rows = [lines[index], lines[index + 1]]
            index += 2
            while (
                index < len(lines)
                and lines[index].startswith("|")
                and lines[index].endswith("|")
            ):
                rows.append(lines[index])
                index += 1
            tables.append("\n".join(rows))
            continue
        index += 1
    return tables


def normalize_blank_runs(lines: list[str]) -> list[str]:
    normalized: list[str] = []
    previous_blank = False
    in_fence = False
    fence_marker: str | None = None
    for line in lines:
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
        if is_blank and previous_blank and not in_fence:
            continue
        normalized.append("" if is_blank else line)
        previous_blank = is_blank
    while normalized and normalized[-1] == "":
        normalized.pop()
    return normalized


def source_preservation_audit(report_path: Path, report: dict) -> dict:
    folder = report_path.parent
    baseline_lines = (folder / "baseline.md").read_text(encoding="utf-8").splitlines()
    ingestion_text = (folder / "ingestion.md").read_text(encoding="utf-8")
    removed_indices: set[int] = set()
    partial_metadata_valid = True
    for block in report.get("blocks", []):
        verified = [row for row in block.get("rows", []) if row.get("verified")]
        if block.get("inserted"):
            expected_partial = len(verified) != len(block.get("rows", []))
            partial_metadata_valid &= block.get("partial") == expected_partial
            partial_metadata_valid &= len(block.get("inserted_labels", [])) == len(verified)
        for row in verified:
            source_lines = (
                row["source_lines"]
                if "source_lines" in row
                else [row.get("label_line"), row.get("value_line")]
            )
            for line_number in source_lines:
                if not isinstance(line_number, int) or not 1 <= line_number <= len(baseline_lines):
                    partial_metadata_valid = False
                    continue
                removed_indices.add(line_number - 1)

    expected_source = [
        line for index, line in enumerate(baseline_lines) if index not in removed_indices
    ]
    ingestion_lines = ingestion_text.splitlines()
    actual_source: list[str] = []
    inside_synthetic = False
    skip_inserted_blank = False
    for line in ingestion_lines:
        if line.startswith("<!-- hybrid-key-value:start "):
            inside_synthetic = True
            continue
        if line == "<!-- hybrid-key-value:end -->":
            inside_synthetic = False
            skip_inserted_blank = True
            continue
        if inside_synthetic:
            continue
        if skip_inserted_blank and line == "":
            skip_inserted_blank = False
            continue
        skip_inserted_blank = False
        actual_source.append(line)

    baseline_tables = Counter(markdown_tables("\n".join(baseline_lines)))
    ingestion_tables = Counter(markdown_tables(ingestion_text))
    preserved_tables = sum(
        min(count, ingestion_tables[table]) for table, count in baseline_tables.items()
    )
    return {
        "source_preserved": normalize_blank_runs(actual_source)
        == normalize_blank_runs(expected_source),
        "removed_verified_source_lines": len(removed_indices),
        "partial_metadata_valid": partial_metadata_valid,
        "genuine_tables": sum(baseline_tables.values()),
        "preserved_genuine_tables": preserved_tables,
    }


def evaluate_gate(name: str, value: float, operator: str, threshold: float) -> dict:
    passed = value >= threshold if operator == "min" else value <= threshold
    return {
        "name": name,
        "value": value,
        "operator": operator,
        "threshold": threshold,
        "status": "passed" if passed else "failed",
    }


def apply_gates(summary: dict, gates: dict) -> dict:
    metrics = gates["metrics"]
    checks = [
        evaluate_gate("precision", summary["precision"], "min", metrics["minPrecision"]),
        evaluate_gate("recall", summary["recall"], "min", metrics["minRecall"]),
        evaluate_gate(
            "criticalFalseAssociations",
            summary["critical_false_associations"],
            "max",
            metrics["maxCriticalFalseAssociations"],
        ),
        evaluate_gate(
            "criticalFalseNegatives",
            summary["critical_false_negatives"],
            "max",
            metrics["maxCriticalFalseNegatives"],
        ),
        evaluate_gate(
            "criticalRecall",
            summary["critical_recall"],
            "min",
            metrics["minCriticalRecall"],
        ),
        evaluate_gate(
            "eligibleDocumentCoverage",
            summary["eligible_document_coverage"],
            "min",
            metrics["minEligibleDocumentCoverage"],
        ),
        evaluate_gate(
            "eligibilityAccuracy",
            summary["eligibility_accuracy"],
            "min",
            metrics["minEligibilityAccuracy"],
        ),
        evaluate_gate(
            "tablePreservation",
            summary["table_preservation"],
            "min",
            metrics["minTablePreservation"],
        ),
        evaluate_gate(
            "sourcePreservation",
            summary["source_preservation"],
            "min",
            metrics["minSourcePreservation"],
        ),
        evaluate_gate(
            "partialMetadataAccuracy",
            summary["partial_metadata_accuracy"],
            "min",
            metrics["minPartialMetadataAccuracy"],
        ),
        evaluate_gate(
            "duplicateAssociations",
            summary["duplicate_associations"],
            "max",
            metrics["maxDuplicateAssociations"],
        ),
    ]
    evidence = evaluate_gate(
        "predictedPairEvidence",
        summary["predicted_pairs"],
        "min",
        metrics["minPredictedPairs"],
    )
    if evidence["status"] == "failed":
        evidence["status"] = "insufficient_evidence"
    checks.append(evidence)
    if any(check["status"] == "failed" for check in checks):
        verdict = "fail"
    elif any(check["status"] == "insufficient_evidence" for check in checks):
        verdict = "insufficient_evidence"
    else:
        verdict = "pass"
    return {
        "schema": "sds-hybrid-gate-result/v1",
        "gateId": gates["gateId"],
        "verdict": verdict,
        "checks": checks,
    }


def evaluate(output_dir: Path, truth: dict, gates: dict | None = None) -> dict:
    reports = [
        (path, json.loads(path.read_text(encoding="utf-8")))
        for path in output_dir.rglob("key-values.json")
    ]
    results = []
    missing_documents = []
    eligibility_matches = 0
    eligibility_expected = 0
    source_audits = []
    for document in truth["documents"]:
        matches = [
            (path, report)
            for path, report in reports
            if report.get("source", "").endswith(document["source_suffix"])
        ]
        if len(matches) != 1:
            missing_documents.append(
                {"source_suffix": document["source_suffix"], "matches": len(matches)}
            )
            continue
        path, report = matches[0]
        actual = load_actual(report)
        baseline_markdown = (path.parent / "baseline.md").read_text(encoding="utf-8")
        scopes = [
            score_scope(actual, scope, baseline_markdown)
            for scope in document["scopes"]
        ]
        allowed_statuses = document.get("allowed_eligibility_statuses")
        actual_status = report.get("eligibility", {}).get("status")
        eligibility_match = None
        if allowed_statuses is not None:
            eligibility_expected += 1
            eligibility_match = actual_status in allowed_statuses
            eligibility_matches += int(eligibility_match)
        audit = source_preservation_audit(path, report)
        source_audits.append(audit)
        results.append(
            {
                "source_suffix": document["source_suffix"],
                "report": str(path),
                "exclude_from_pair_coverage": document.get(
                    "exclude_from_pair_coverage", False
                ),
                "eligibility": {
                    "actual": actual_status,
                    "allowed": allowed_statuses,
                    "matches": eligibility_match,
                },
                "source_audit": audit,
                "scopes": scopes,
            }
        )

    scopes = [scope for result in results for scope in result["scopes"]]
    tp = sum(scope["true_positives"] for scope in scopes)
    recovered_tp = sum(scope["recovered_true_positives"] for scope in scopes)
    baseline_tp = sum(scope["baseline_true_positives"] for scope in scopes)
    fp = sum(len(scope["false_positives"]) for scope in scopes)
    duplicates = sum(scope["duplicates"] for scope in scopes)
    critical_fp = sum(len(scope["critical_false_positives"]) for scope in scopes)
    critical_fn = sum(len(scope["critical_false_negatives"]) for scope in scopes)
    critical_expected = sum(scope["critical_expected"] for scope in scopes)
    critical_tp = sum(scope["critical_true_positives"] for scope in scopes)
    expected = sum(scope["expected"] for scope in scopes)
    predicted = recovered_tp + fp + duplicates
    precision = recovered_tp / predicted if predicted else 1.0
    recall = tp / expected if expected else 1.0
    coverage_results = [
        result for result in results if not result["exclude_from_pair_coverage"]
    ]
    covered_documents = sum(
        any(scope["true_positives"] > 0 for scope in result["scopes"])
        for result in coverage_results
    )
    genuine_tables = sum(audit["genuine_tables"] for audit in source_audits)
    preserved_tables = sum(
        audit["preserved_genuine_tables"] for audit in source_audits
    )
    summary = {
        "schema": "sds-hybrid-evaluation/v3",
        "documents_expected": len(truth["documents"]),
        "documents_scored": len(results),
        "missing_documents": missing_documents,
        "true_positives": tp,
        "recovered_true_positives": recovered_tp,
        "baseline_true_positives": baseline_tp,
        "false_positives": fp,
        "critical_false_associations": critical_fp,
        "critical_false_negatives": critical_fn,
        "critical_expected_pairs": critical_expected,
        "critical_recall": (
            critical_tp / critical_expected if critical_expected else 1.0
        ),
        "duplicate_associations": duplicates,
        "expected_pairs": expected,
        "predicted_pairs": predicted,
        "precision": precision,
        "recall": recall,
        "eligible_document_coverage": (
            covered_documents / len(coverage_results) if coverage_results else 1.0
        ),
        "eligibility_accuracy": (
            eligibility_matches / eligibility_expected if eligibility_expected else 1.0
        ),
        "table_preservation": (
            preserved_tables / genuine_tables if genuine_tables else 1.0
        ),
        "source_preservation": (
            sum(audit["source_preserved"] for audit in source_audits)
            / len(source_audits)
            if source_audits
            else 1.0
        ),
        "partial_metadata_accuracy": (
            sum(audit["partial_metadata_valid"] for audit in source_audits)
            / len(source_audits)
            if source_audits
            else 1.0
        ),
        "results": results,
    }
    if gates is not None:
        summary["gate_result"] = apply_gates(summary, gates)
    return summary


def main() -> int:
    args = parse_args()
    truth = json.loads(args.ground_truth.read_text(encoding="utf-8"))
    gates = json.loads(args.gates.read_text(encoding="utf-8")) if args.gates else None
    summary = evaluate(args.output_dir, truth, gates)
    rendered = json.dumps(summary, ensure_ascii=False, indent=2) + "\n"
    if args.json_output:
        args.json_output.parent.mkdir(parents=True, exist_ok=True)
        args.json_output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")

    if gates is not None:
        return 0 if summary["gate_result"]["verdict"] == "pass" else 1
    failed = (
        bool(summary["missing_documents"])
        or summary["precision"] < args.min_precision
        or summary["recall"] < args.min_recall
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
