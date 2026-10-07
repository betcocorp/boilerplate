from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("freeze-sds-expanded-benchmark.py")
SPEC = importlib.util.spec_from_file_location("freeze_sds_expanded_benchmark", MODULE_PATH)
assert SPEC and SPEC.loader
freezer = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = freezer
SPEC.loader.exec_module(freezer)


class ExpandedBenchmarkFreezerTests(unittest.TestCase):
    def test_field_separator_wins_over_colons_inside_label_and_value(self) -> None:
        parsed = freezer.parse_pair(
            "Partition coefficient: n-octanol/water   : Not applicable."
        )
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed[:2], ("Partition coefficient: n-octanol/water", "Not applicable."))

        parsed = freezer.parse_pair(
            "Viscosity   : Dynamic (room temperature): Not applicable."
        )
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(
            parsed[:2],
            ("Viscosity", "Dynamic (room temperature): Not applicable."),
        )

    def test_ambiguous_headers_and_duplicated_column_values_are_cleaned(self) -> None:
        self.assertIsNone(
            freezer.clean_direct_value(
                "Vapor Pressure at 20˚C", "Vapor pressure at 50˚C"
            )
        )
        self.assertIsNone(
            freezer.clean_direct_value(
                "Appearance", "black powder Odor No information available"
            )
        )
        self.assertEqual(
            freezer.clean_direct_value(
                "Flammability (solid, gas)",
                "No data available No data available",
            ),
            "No data available",
        )

    def test_value_continuations_are_source_grounded(self) -> None:
        text = (
            "SECTION 9. PHYSICAL AND CHEMICAL PROPERTIES\n"
            "Solubility                         : Easily soluble in cold water.\n"
            "                                     Partially soluble in hot water.\n"
            "SECTION 10. STABILITY AND REACTIVITY\n"
        )
        pairs, pages = freezer.section_9_pairs(text)
        self.assertEqual(pages, [1])
        self.assertEqual(len(pairs), 1)
        self.assertEqual(
            pairs[0]["value"],
            "Easily soluble in cold water. Partially soluble in hot water.",
        )

    def test_incomplete_wrapped_labels_are_excluded(self) -> None:
        text = (
            "9. PHYSICAL AND CHEMICAL PROPERTIES\n"
            "Partition coefficient: n-          : Not applicable.\n"
            "octanol/water\n"
            "Flash point                         : 93 °C\n"
            "10. STABILITY AND REACTIVITY\n"
        )
        pairs, _ = freezer.section_9_pairs(text)
        self.assertEqual(
            [(pair["label"], pair["value"]) for pair in pairs],
            [("Flash point", "93 °C")],
        )

    def test_page_counter_is_not_appended_to_value(self) -> None:
        text = (
            "SECTION 9. PHYSICAL AND CHEMICAL PROPERTIES\n"
            "Flammability (solid, gas)           : not measured\n"
            "                                             5/12\n"
            "SECTION 10. STABILITY AND REACTIVITY\n"
        )
        pairs, _ = freezer.section_9_pairs(text)
        self.assertEqual(pairs[0]["value"], "not measured")


if __name__ == "__main__":
    unittest.main()
