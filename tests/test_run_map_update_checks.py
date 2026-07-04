from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tools import run_map_update_checks as checks


class MapUpdateCheckTests(unittest.TestCase):
    def test_parse_render_metrics_reads_exact_and_mean_diff(self) -> None:
        stdout = "\n".join(
            [
                "rendered candidate: .analysis/example.png",
                "comparison exact pixels: 0.9999",
                "comparison mean RGB sum diff: 0.2",
            ]
        )

        metrics = checks.parse_render_metrics(stdout)

        self.assertEqual(metrics["exact_pixels"], 0.9999)
        self.assertEqual(metrics["mean_rgb_sum_diff"], 0.2)

    def test_lineage_report_requires_underground_exact_match_and_palette_colors(self) -> None:
        report = {
            "candidate_guard": {
                "comparison_to_current_underground": {
                    "target_active_exact_ratio": 1.0,
                    "active_iou": 1.0,
                }
            },
            "current_map": {
                "color_membership": {
                    "pixel_ratio_in_tile_palette": 1.0,
                }
            },
        }

        results = checks.evaluate_lineage_report(
            report,
            min_active_exact=0.9999,
            min_active_iou=0.9999,
            min_palette_ratio=0.9999,
        )

        self.assertTrue(all(result.passed for result in results))

    def test_overlay_report_flags_far_points_and_low_chunk_coverage(self) -> None:
        report = {
            "invalid_coordinates": [],
            "underground_points": [
                {"source": "caves", "name": "near", "nearest_visible_pixel": 3},
                {"source": "portals", "name": "far", "nearest_visible_pixel": 25},
            ],
            "underground_chunk_coverage": {
                "zones": {"total": 10, "with_visible_pixels": 10},
                "encounters": {"total": 10, "with_visible_pixels": 9},
            },
        }

        results = checks.evaluate_overlay_report(
            report,
            max_far_point_px=24,
            min_zone_visible_ratio=0.95,
            min_encounter_visible_ratio=0.95,
        )
        failed_names = {result.name for result in results if not result.passed}

        self.assertEqual(failed_names, {"underground point terrain proximity", "encounter chunk coverage"})


if __name__ == "__main__":
    unittest.main()
