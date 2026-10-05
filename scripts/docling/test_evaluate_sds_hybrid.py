from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("evaluate-sds-hybrid.py")
SPEC = importlib.util.spec_from_file_location("evaluate_sds_hybrid", MODULE_PATH)
assert SPEC and SPEC.loader
evaluator = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = evaluator
SPEC.loader.exec_module(evaluator)


class HybridEvaluationTests(unittest.TestCase):
    def test_wrong_value_is_false_positive_and_false_negative(self) -> None:
        actual = [(5, evaluator.Pair("ph", "9"))]
        scope = {
            "name": "section-9",
            "pages": [5],
            "expected": [
                {"label": "pH", "value": "6.5 to 8.5", "critical": True}
            ],
            "optional": [],
            "forbidden": [],
        }

        result = evaluator.score_scope(actual, scope)

        self.assertEqual(result["true_positives"], 0)
        self.assertEqual(len(result["false_positives"]), 1)
        self.assertEqual(len(result["false_negatives"]), 1)
        self.assertEqual(len(result["critical_false_negatives"]), 1)
        self.assertEqual(result["critical_true_positives"], 0)
        self.assertEqual(result["precision"], 0)
        self.assertEqual(result["recall"], 0)

    def test_optional_pair_does_not_affect_precision_or_recall(self) -> None:
        actual = [
            (5, evaluator.Pair("ph", "6.5 to 8.5")),
            (5, evaluator.Pair("color", "off-white")),
        ]
        scope = {
            "name": "section-9",
            "pages": [5],
            "expected": [{"label": "pH", "value": "6.5 to 8.5"}],
            "optional": [{"label": "Color", "value": "Off-white"}],
            "forbidden": [],
        }

        result = evaluator.score_scope(actual, scope)

        self.assertEqual(result["precision"], 1)
        self.assertEqual(result["recall"], 1)

    def test_baseline_association_counts_for_recall_not_recovery_precision(self) -> None:
        scope = {
            "name": "section-9",
            "pages": [5],
            "expected": [
                {"label": "pH", "value": "8", "critical": True},
                {"label": "Flash point", "value": "93 °C", "critical": True},
            ],
            "optional": [],
            "forbidden": [],
        }
        baseline = (
            "pH 8\n\n"
            "| Property | Value |\n|---|---|\n| Flash point | 93 °C |\n"
        )

        result = evaluator.score_scope([], scope, baseline)

        self.assertEqual(result["true_positives"], 2)
        self.assertEqual(result["recovered_true_positives"], 0)
        self.assertEqual(result["baseline_true_positives"], 2)
        self.assertEqual(result["critical_false_negatives"], [])
        self.assertEqual(result["precision"], 1)
        self.assertEqual(result["recall"], 1)

    def test_include_all_actual_catches_unexpected_labels(self) -> None:
        actual = [
            (4, evaluator.Pair("ph", "7")),
            (4, evaluator.Pair("truncated reac-", "stable")),
        ]
        scope = {
            "name": "section-9",
            "pages": [4],
            "include_all_actual": True,
            "expected": [{"label": "pH", "value": "7"}],
            "optional": [],
            "forbidden": [],
        }

        result = evaluator.score_scope(actual, scope)

        self.assertEqual(result["true_positives"], 1)
        self.assertEqual(len(result["false_positives"]), 1)
        self.assertEqual(result["precision"], 0.5)

    def test_source_audit_proves_exact_deletion_and_table_preservation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            baseline = (
                "A :\nB :\nC :\n1\n2\n3\n\n"
                "| Chemical | Value |\n|---|---|\n| Water | 17.5 |\n"
            )
            ingestion = (
                "<!-- hybrid-key-value:start page=1 -->\n"
                "| Property | Value |\n|---|---|\n| A | 1 |\n| B | 2 |\n| C | 3 |\n"
                "<!-- hybrid-key-value:end -->\n\n"
                "\n| Chemical | Value |\n|---|---|\n| Water | 17.5 |\n"
            )
            (folder / "baseline.md").write_text(baseline)
            (folder / "ingestion.md").write_text(ingestion)
            report = {
                "blocks": [{
                    "inserted": True,
                    "partial": False,
                    "inserted_labels": ["A", "B", "C"],
                    "rows": [
                        {"verified": True, "label_line": 1, "value_line": 4},
                        {"verified": True, "label_line": 2, "value_line": 5},
                        {"verified": True, "label_line": 3, "value_line": 6},
                    ],
                }]
            }
            report_path = folder / "key-values.json"
            report_path.write_text(json.dumps(report))

            audit = evaluator.source_preservation_audit(report_path, report)

            self.assertTrue(audit["source_preserved"])
            self.assertTrue(audit["partial_metadata_valid"])
            self.assertEqual(audit["genuine_tables"], 1)
            self.assertEqual(audit["preserved_genuine_tables"], 1)

    def test_gate_reports_insufficient_evidence_separately(self) -> None:
        summary = {
            "precision": 1.0,
            "recall": 0.9,
            "critical_false_associations": 0,
            "critical_false_negatives": 0,
            "critical_recall": 1.0,
            "eligible_document_coverage": 1.0,
            "eligibility_accuracy": 1.0,
            "table_preservation": 1.0,
            "source_preservation": 1.0,
            "partial_metadata_accuracy": 1.0,
            "duplicate_associations": 0,
            "predicted_pairs": 50,
        }
        gates = {
            "gateId": "test",
            "metrics": {
                "minPrecision": 0.995,
                "minRecall": 0.85,
                "minPredictedPairs": 600,
                "maxCriticalFalseAssociations": 0,
                "maxCriticalFalseNegatives": 0,
                "minCriticalRecall": 1.0,
                "minEligibleDocumentCoverage": 0.9,
                "minEligibilityAccuracy": 0.99,
                "minTablePreservation": 1.0,
                "minSourcePreservation": 1.0,
                "minPartialMetadataAccuracy": 1.0,
                "maxDuplicateAssociations": 0,
            },
        }

        result = evaluator.apply_gates(summary, gates)

        self.assertEqual(result["verdict"], "insufficient_evidence")
        self.assertEqual(result["checks"][-1]["status"], "insufficient_evidence")


if __name__ == "__main__":
    unittest.main()
