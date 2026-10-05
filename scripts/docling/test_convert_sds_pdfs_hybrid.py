from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("convert-sds-pdfs-hybrid.py")
SPEC = importlib.util.spec_from_file_location("convert_sds_pdfs_hybrid", MODULE_PATH)
assert SPEC and SPEC.loader
hybrid = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = hybrid
SPEC.loader.exec_module(hybrid)


def row(label: str, value: str) -> hybrid.KeyValueRow:
    return hybrid.KeyValueRow(label, value, 0, 1, 200, 20, 220)


class HybridPlacementTests(unittest.TestCase):
    def test_empty_baseline_stays_empty_for_unsupported_scans(self) -> None:
        comparison, ingestion = hybrid.build_markdown_outputs("", [])
        self.assertEqual(comparison, "")
        self.assertEqual(ingestion, "")

    def test_ingestion_collapses_blank_runs_but_preserves_fenced_content(self) -> None:
        source = "# Heading\n\n\n\nText\n\n```text\n\n\nvalue\n```\n\n\nEnd\n"

        comparison, ingestion = hybrid.build_markdown_outputs(source, [])

        self.assertEqual(comparison, source)
        self.assertEqual(
            ingestion,
            "# Heading\n\nText\n\n```text\n\n\nvalue\n```\n\nEnd\n",
        )

    def test_aligned_gap_rows_are_recovered_without_colons(self) -> None:
        def visual(label: str, value: str, top: float) -> hybrid.VisualLine:
            return hybrid.VisualLine(
                words=[
                    hybrid.PositionedWord(label, 20, top, 100, top + 10),
                    hybrid.PositionedWord(value, 220, top, 300, top + 10),
                ]
            )

        blocks = hybrid.recover_aligned_gap_blocks_from_lines(
            page_number=4,
            lines=[
                visual("Physical state", "Liquid", 10),
                visual("Color", "Colorless", 24),
                visual("pH", "8", 38),
            ],
            min_pairs=3,
        )

        self.assertEqual(len(blocks), 1)
        self.assertEqual(blocks[0].confidence, "aligned-gap")
        self.assertEqual(
            [(item.label, item.value) for item in blocks[0].rows],
            [("Physical state", "Liquid"), ("Color", "Colorless"), ("pH", "8")],
        )

    def test_aligned_gap_completes_label_ending_in_function_word(self) -> None:
        def visual(parts: list[tuple[str, float, float]], top: float) -> hybrid.VisualLine:
            return hybrid.VisualLine(
                words=[
                    hybrid.PositionedWord(text, left, top, right, top + 10)
                    for text, left, right in parts
                ]
            )

        blocks = hybrid.recover_aligned_gap_blocks_from_lines(
            page_number=1,
            lines=[
                visual([("GHS product identifier", 20, 120), ("Product", 220, 280)], 10),
                visual([("Product code", 20, 100), ("M000133", 220, 280)], 24),
                visual([("Other means of", 20, 100), ("Not available.", 220, 300)], 38),
                visual([("identification", 20, 90)], 50),
                visual([("Product type", 20, 100), ("Liquid", 220, 260)], 64),
            ],
            min_pairs=3,
        )

        block = next(item for item in blocks if item.rows[0].value_left == 220)
        self.assertEqual(block.rows[2].label, "Other means of identification")

    def test_aligned_gap_uses_shared_value_column_before_metadata_columns(self) -> None:
        def visual(label: str, value: str, metadata: str, top: float) -> hybrid.VisualLine:
            return hybrid.VisualLine(
                words=[
                    hybrid.PositionedWord(label, 20, top, 120, top + 10),
                    hybrid.PositionedWord(value, 220, top, 290, top + 10),
                    hybrid.PositionedWord(metadata, 370, top, 430, top + 10),
                ]
            )

        blocks = hybrid.recover_aligned_gap_blocks_from_lines(
            page_number=4,
            lines=[
                visual("Flammability", "No data available", "No data available", 10),
                visual("Autoignition", "No data available", "N/A", 24),
                visual("Specific gravity", "No information available", "N/A", 38),
            ],
            min_pairs=3,
        )
        value_column_block = next(
            block for block in blocks if abs(block.rows[0].value_left - 220) < 1
        )
        self.assertEqual(value_column_block.rows[0].value, "No data available")
        self.assertEqual(value_column_block.rows[1].value, "No data available N/A")

    def test_eligibility_is_explicit_for_partial_and_unsupported_outputs(self) -> None:
        unsupported = hybrid.determine_eligibility("", [], native_word_count=0)
        self.assertEqual(unsupported["status"], "unsupported")
        self.assertFalse(unsupported["ingestionAllowed"])

        structured = hybrid.determine_eligibility(
            "## 9 Physical and chemical properties\n\n| Property | Value |\n|---|---|\n| pH | 8 |\n\n## 10 Stability\n"
            + "x" * 300,
            [],
            native_word_count=30,
        )
        self.assertEqual(structured["status"], "eligible")
        self.assertEqual(structured["recommendedArtifact"], "baseline.md")

        block = hybrid.KeyValueBlock(
            page=1,
            colon_x=200,
            rows=[row("A", "1"), row("B", "2"), row("C", "3")],
            inserted=True,
            partial=True,
        )
        partial = hybrid.determine_eligibility(
            "x" * 300,
            [block],
            native_word_count=30,
        )
        self.assertEqual(partial["status"], "partial")
        self.assertIn("partial-blocks", partial["reasonCodes"])

        block.partial = False
        small = hybrid.determine_eligibility(
            "x" * 300,
            [block],
            native_word_count=30,
        )
        self.assertEqual(small["status"], "partial")
        self.assertIn("insufficient-verified-rows", small["reasonCodes"])

    def test_n_octanol_anchor_variants_are_canonicalized(self) -> None:
        self.assertEqual(
            hybrid.normalize_anchor("Partition coefficient: n- octanol/water"),
            hybrid.normalize_anchor("Partition coefficient: noctanol/water :"),
        )

    def test_overlapping_blocks_merge_only_complementary_verified_rows(self) -> None:
        first = hybrid.KeyValueBlock(
            page=1,
            colon_x=100,
            rows=[row("A", "1"), row("B", "2"), row("C", "3")],
            confidence="explicit-colon-alignment",
        )
        second = hybrid.KeyValueBlock(
            page=1,
            colon_x=200,
            rows=[row("B", "2"), row("C", "3"), row("D", "4")],
            confidence="aligned-gap",
        )
        source = "A :\nB :\nC :\nD :\n1\n2\n3\n4\n"

        comparison, ingestion = hybrid.build_markdown_outputs(source, [first, second])

        self.assertEqual(comparison.count("hybrid-key-value:start"), 1)
        self.assertIn("| A | 1 |", comparison)
        self.assertIn("| D | 4 |", comparison)
        self.assertEqual(comparison.count("| B | 2 |"), 1)
        self.assertEqual(first.confidence, "merged-coordinate-evidence")
        self.assertFalse(second.inserted)
        self.assertEqual(ingestion.count("| D | 4 |"), 1)

    def test_wrapped_label_does_not_merge_a_new_heading(self) -> None:
        lines = [
            "Hazard statements",
            ": No known significant effects or critical hazards.",
            "Precautionary statements",
        ]
        normalized = [hybrid.normalize_anchor(line) for line in lines]

        spans = hybrid.find_wrapped_label_spans(
            lines,
            normalized,
            "hazard statements precautionary statements",
            0,
            len(lines),
        )

        self.assertEqual(spans, [])

    def test_wrapped_labels_and_inline_pairs_are_verified_locally(self) -> None:
        block = hybrid.KeyValueBlock(
            page=5,
            colon_x=200,
            rows=[
                row("Physical state", "Liquid."),
                row("Lower and upper explosive (flammable) limits", "Not available."),
                row("Decomposition temperature", "Not available."),
            ],
        )
        source = (
            "Physical state :\nLiquid.\n"
            "Lower and upper explosive\n: Not available.\n(fammable placeholder)\n"
            "(flammable) limits\n"
            "Decomposition temperature : Not available.\n"
        ).replace("(fammable placeholder)\n", "")

        comparison, ingestion = hybrid.build_markdown_outputs(source, [block])

        self.assertTrue(block.inserted)
        self.assertFalse(block.partial)
        self.assertIn("wrapped-label-local", {item.verification_mode for item in block.rows})
        self.assertIn("inline-local", {item.verification_mode for item in block.rows})
        self.assertEqual(ingestion.count("Lower and upper explosive"), 1)
        self.assertNotIn("Decomposition temperature : Not available.", ingestion)
        self.assertIn("| Decomposition temperature | Not available. |", comparison)

    def test_first_inline_row_can_anchor_a_verified_block(self) -> None:
        block = hybrid.KeyValueBlock(
            page=1,
            colon_x=200,
            rows=[
                row("Appearance", "White"),
                row("Physical state", "Powder"),
                row("Odor", "Odorless"),
            ],
        )
        source = "Appearance White\n\nPhysical state Powder\n\nOdor Odorless\n"

        comparison, ingestion = hybrid.build_markdown_outputs(source, [block])

        self.assertTrue(block.inserted)
        self.assertFalse(block.partial)
        self.assertIn("| Appearance | White |", comparison)
        self.assertNotIn("Appearance White", ingestion)

    def test_coordinate_grounded_row_stays_additive_when_flattened_source_is_ambiguous(self) -> None:
        block = hybrid.KeyValueBlock(
            page=1,
            colon_x=200,
            confidence="aligned-gap",
            rows=[
                row("Appearance", "White"),
                row("Physical state", "Powder"),
                row("Odor", "Odorless"),
                row("Flash point", "93 °C"),
            ],
        )
        source = (
            "Appearance White\nPhysical state Powder\nOdor Odorless\n"
            "Flash point\nValues elsewhere in flattened order\n"
        )

        comparison, ingestion = hybrid.build_markdown_outputs(source, [block])

        flash = next(item for item in block.rows if item.label == "Flash point")
        self.assertTrue(flash.verified)
        self.assertEqual(flash.verification_mode, "coordinate-grounded-unremoved")
        self.assertEqual(flash.source_lines, [])
        self.assertIn("| Flash point | 93 °C |", comparison)
        self.assertIn("Flash point", ingestion)

    def test_column_major_values_are_ordered_and_deduplicated(self) -> None:
        block = hybrid.KeyValueBlock(
            page=1,
            colon_x=200,
            rows=[
                row("Physical state", "Liquid."),
                row("Color", "Off-white."),
                row("pH", "6.5 to 8.5"),
            ],
        )
        source = (
            "Physical state :\n\nColor :\n\npH :\n\n"
            "Liquid.\nOff-white.\n6.5 to 8.5\n"
        )

        comparison, ingestion = hybrid.build_markdown_outputs(source, [block])

        self.assertIn("partial=false", comparison)
        self.assertEqual(comparison.count("6.5 to 8.5"), 2)
        self.assertEqual(ingestion.count("6.5 to 8.5"), 1)
        self.assertNotIn("Physical state :", ingestion)
        self.assertTrue(all(item.verified for item in block.rows))
        self.assertTrue(
            all(
                item.verification_mode in {"ordered-local", "interleaved-local"}
                for item in block.rows
            )
        )

    def test_missing_repeated_value_cannot_validate_later_rows(self) -> None:
        block = hybrid.KeyValueBlock(
            page=1,
            colon_x=200,
            rows=[
                row("First", "Not available."),
                row("Second", "Not available."),
                row("Third", "Present"),
            ],
        )
        source = "First :\nSecond :\nThird :\nNot available.\nPresent\n"

        comparison, ingestion = hybrid.build_markdown_outputs(source, [block])

        self.assertFalse(block.inserted)
        self.assertNotIn("hybrid-key-value", comparison)
        self.assertEqual(ingestion, comparison)

    def test_truncated_hyphenated_label_is_not_rendered(self) -> None:
        block = hybrid.KeyValueBlock(
            page=1,
            colon_x=200,
            rows=[
                row("Stable property", "One"),
                row("Possibility of hazardous reac-", "Stable"),
                row("Conditions to avoid", "None"),
                row("Other property", "Four"),
            ],
        )
        source = (
            "Stable property :\nPossibility of hazardous reac- :\n"
            "Conditions to avoid :\nOther property :\nOne\nStable\nNone\nFour\n"
        )

        comparison, _ = hybrid.build_markdown_outputs(source, [block])

        self.assertTrue(block.inserted)
        self.assertNotIn("| Possibility of hazardous reac- |", comparison)
        self.assertIn("Possibility of hazardous reac-", block.omitted_labels)

    def test_distant_common_value_after_heading_is_not_accepted(self) -> None:
        block = hybrid.KeyValueBlock(
            page=1,
            colon_x=200,
            rows=[
                row("First", "One"),
                row("Second", "Two"),
                row("Flow time", "Not available."),
            ],
        )
        source = (
            "First :\nSecond :\nFlow time :\nOne\nTwo\n"
            "## Next section\nNot available.\n"
        )

        comparison, ingestion = hybrid.build_markdown_outputs(source, [block])

        self.assertFalse(block.inserted)
        self.assertNotIn("hybrid-key-value", comparison)
        self.assertIn("Not available.", ingestion)

    def test_partial_table_is_marked_and_unmatched_content_remains(self) -> None:
        block = hybrid.KeyValueBlock(
            page=2,
            colon_x=200,
            rows=[
                row("First", "One"),
                row("Second", "Two"),
                row("Merged missing label", "Three"),
                row("Fourth", "Four"),
            ],
        )
        source = "First :\nSecond :\nFourth :\nOne\nTwo\nThree\nFour\n"

        comparison, ingestion = hybrid.build_markdown_outputs(source, [block])

        self.assertTrue(block.inserted)
        self.assertTrue(block.partial)
        self.assertEqual(block.omitted_labels, ["Merged missing label"])
        self.assertIn("partial=true inserted_rows=3 detected_rows=4", comparison)
        self.assertIn("Three", ingestion)
        self.assertNotIn("First :", ingestion)

    def test_deduplication_preserves_genuine_tables(self) -> None:
        block = hybrid.KeyValueBlock(
            page=1,
            colon_x=200,
            rows=[row("A", "1"), row("B", "2"), row("C", "3")],
        )
        genuine = "| Chemical | Value |\n|---|---|\n| Water | 17.5 |"
        source = f"A :\nB :\nC :\n1\n2\n3\n\n{genuine}\n"

        _, ingestion = hybrid.build_markdown_outputs(source, [block])

        self.assertIn(genuine, ingestion)
        self.assertEqual(ingestion.count("| Water | 17.5 |"), 1)


class IngestionPackageTests(unittest.TestCase):
    def test_manifest_round_trip_matches_production_contract(self) -> None:
        fixture = (
            Path(__file__).with_name("fixtures")
            / "sds-ingestion-canary-manifest.csv"
        )
        content = fixture.read_text(encoding="utf-8")

        rows = hybrid.parse_ingestion_manifest(content)

        self.assertEqual(len(rows), 2)
        self.assertEqual(
            rows[0],
            hybrid.IngestionManifestRow(
                "b0e2d441-a7cb-4bee-9c6e-01aee328edb8",
                "Finished Good SDS/Push (Mint)_M000133.pdf",
                "markdown/push-mint.md",
            ),
        )
        self.assertEqual(hybrid.render_ingestion_manifest(rows), content)

    def test_manifest_rejects_unsafe_and_duplicate_identities(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsafe markdown_path"):
            hybrid.parse_ingestion_manifest(
                "document_id,s3_key,markdown_path\n"
                "b0e2d441-a7cb-4bee-9c6e-01aee328edb8,a.pdf,../a.md\n"
            )
        with self.assertRaisesRegex(ValueError, "duplicate identity"):
            hybrid.parse_ingestion_manifest(
                "document_id,s3_key,markdown_path\n"
                "b0e2d441-a7cb-4bee-9c6e-01aee328edb8,a.pdf,a.md\n"
                "b0e2d441-a7cb-4bee-9c6e-01aee328edb8,b.pdf,b.md\n"
            )

    def test_artifact_selection_fails_closed(self) -> None:
        eligible = {
            "status": "eligible",
            "reasonCodes": ["structured-section-9-table"],
            "recommendedArtifact": "baseline.md",
        }
        self.assertEqual(
            hybrid.select_ingestion_artifact(eligible, "baseline", "ingestion", False),
            ("baseline.md", "baseline\n"),
        )

        partial = {
            "status": "partial",
            "reasonCodes": ["partial-blocks"],
            "recommendedArtifact": "ingestion.md",
        }
        with self.assertRaisesRegex(ValueError, "--include-partial"):
            hybrid.select_ingestion_artifact(partial, "baseline", "ingestion", False)
        self.assertEqual(
            hybrid.select_ingestion_artifact(partial, "baseline", "ingestion", True),
            ("ingestion.md", "ingestion\n"),
        )

        unsupported = {
            "status": "unsupported",
            "reasonCodes": ["no-native-text"],
            "recommendedArtifact": "baseline.md",
        }
        with self.assertRaisesRegex(ValueError, "unsupported document"):
            hybrid.select_ingestion_artifact(unsupported, "baseline", "ingestion", True)


if __name__ == "__main__":
    unittest.main()
