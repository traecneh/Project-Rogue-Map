from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EXTRACTED_DIR = ROOT / ".analysis" / "rogue_data_vpack_2026-07-03"
DEFAULT_MAP_IMAGE = ROOT / "img" / "Map_Combined.png"
DEFAULT_DATA_DIR = ROOT / "data"


@dataclass(frozen=True)
class CheckResult:
    name: str
    passed: bool
    detail: str


class CommandFailed(RuntimeError):
    def __init__(self, command: list[str], returncode: int, stdout: str, stderr: str) -> None:
        self.command = command
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        super().__init__(f"command failed with exit {returncode}: {format_command(command)}")


def format_command(command: list[str]) -> str:
    return " ".join(str(part) for part in command)


def run_command(command: list[str]) -> str:
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
    if result.returncode != 0:
        raise CommandFailed(command, result.returncode, result.stdout, result.stderr)
    return result.stdout


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def parse_float_line(stdout: str, label: str) -> float:
    match = re.search(rf"^{re.escape(label)}:\s*([0-9]+(?:\.[0-9]+)?)\s*$", stdout, re.MULTILINE)
    if not match:
        raise ValueError(f"could not find '{label}' in command output")
    return float(match.group(1))


def parse_render_metrics(stdout: str) -> dict[str, float]:
    return {
        "exact_pixels": parse_float_line(stdout, "comparison exact pixels"),
        "mean_rgb_sum_diff": parse_float_line(stdout, "comparison mean RGB sum diff"),
    }


def result(name: str, passed: bool, detail: str) -> CheckResult:
    return CheckResult(name=name, passed=passed, detail=detail)


def percent(value: float) -> str:
    return f"{value * 100:.2f}%"


def coverage_ratio(stats: dict[str, Any]) -> float:
    total = int(stats.get("total", 0))
    if total == 0:
        return 0.0
    return int(stats.get("with_visible_pixels", 0)) / total


def evaluate_lineage_report(
    report: dict[str, Any],
    *,
    min_active_exact: float,
    min_active_iou: float,
    min_palette_ratio: float,
) -> list[CheckResult]:
    comparison = report["candidate_guard"]["comparison_to_current_underground"]
    color_membership = report["current_map"]["color_membership"]

    active_exact = float(comparison["target_active_exact_ratio"])
    active_iou = float(comparison["active_iou"])
    palette_ratio = float(color_membership["pixel_ratio_in_tile_palette"])

    return [
        result(
            "underground tile identity",
            active_exact >= min_active_exact,
            f"{percent(active_exact)} active exact; threshold {percent(min_active_exact)}",
        ),
        result(
            "underground active IoU",
            active_iou >= min_active_iou,
            f"{percent(active_iou)} active IoU; threshold {percent(min_active_iou)}",
        ),
        result(
            "map colors in extracted tile palette",
            palette_ratio >= min_palette_ratio,
            f"{percent(palette_ratio)} of pixels use extracted tile colors; threshold {percent(min_palette_ratio)}",
        ),
    ]


def evaluate_overlay_report(
    report: dict[str, Any],
    *,
    max_far_point_px: int,
    min_zone_visible_ratio: float,
    min_encounter_visible_ratio: float,
) -> list[CheckResult]:
    invalid = report.get("invalid_coordinates", [])
    underground_points = report.get("underground_points", [])
    far_points = [
        point
        for point in underground_points
        if point.get("nearest_visible_pixel") is None or int(point["nearest_visible_pixel"]) > max_far_point_px
    ]
    coverage = report["underground_chunk_coverage"]
    zone_ratio = coverage_ratio(coverage["zones"])
    encounter_ratio = coverage_ratio(coverage["encounters"])

    return [
        result(
            "manual overlay coordinates in bounds",
            len(invalid) == 0,
            f"{len(invalid)} invalid coordinate records",
        ),
        result(
            "underground point terrain proximity",
            len(far_points) == 0,
            f"{len(far_points)} points farther than {max_far_point_px}px from visible terrain",
        ),
        result(
            "zone chunk coverage",
            zone_ratio >= min_zone_visible_ratio,
            f"{coverage['zones']['with_visible_pixels']}/{coverage['zones']['total']} underground zone chunks touch visible terrain ({percent(zone_ratio)})",
        ),
        result(
            "encounter chunk coverage",
            encounter_ratio >= min_encounter_visible_ratio,
            f"{coverage['encounters']['with_visible_pixels']}/{coverage['encounters']['total']} underground encounter chunks touch visible terrain ({percent(encounter_ratio)})",
        ),
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run Project Rogue map update checks after img/Map_Combined.png has been regenerated "
            "from the latest extracted client data."
        )
    )
    parser.add_argument("--extracted-dir", type=Path, default=DEFAULT_EXTRACTED_DIR)
    parser.add_argument("--map-image", type=Path, default=DEFAULT_MAP_IMAGE)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--render-output", type=Path, default=None)
    parser.add_argument("--render-thumbnail", type=Path, default=None)
    parser.add_argument("--lineage-report", type=Path, default=None)
    parser.add_argument("--overlay-report", type=Path, default=None)
    parser.add_argument("--overlay-diagnostic", type=Path, default=None)
    parser.add_argument("--min-render-exact", type=float, default=0.9999)
    parser.add_argument("--max-render-mean-diff", type=float, default=0.1)
    parser.add_argument("--min-active-exact", type=float, default=0.9999)
    parser.add_argument("--min-active-iou", type=float, default=0.9999)
    parser.add_argument("--min-palette-ratio", type=float, default=0.9999)
    parser.add_argument("--max-far-point-px", type=int, default=24)
    parser.add_argument("--min-zone-visible-ratio", type=float, default=0.95)
    parser.add_argument("--min-encounter-visible-ratio", type=float, default=0.95)
    return parser.parse_args()


def default_output(path: Path | None, extracted_dir: Path, name: str) -> Path:
    return path if path is not None else extracted_dir / name


def py_compile_tools() -> CheckResult:
    tool_files = sorted((ROOT / "tools").glob("*.py"))
    command = [sys.executable, "-m", "py_compile", *[str(path) for path in tool_files]]
    run_command(command)
    return result("tool syntax", True, f"compiled {len(tool_files)} Python tool files")


def print_command_failure(error: CommandFailed) -> None:
    print(f"[FAIL] {format_command(error.command)}")
    print(f"exit code: {error.returncode}")
    if error.stdout:
        print("\nstdout:")
        print(error.stdout.rstrip())
    if error.stderr:
        print("\nstderr:")
        print(error.stderr.rstrip())


def main() -> int:
    args = parse_args()
    extracted_dir = args.extracted_dir
    render_output = default_output(args.render_output, extracted_dir, "map_update_healthcheck_render.png")
    render_thumbnail = default_output(args.render_thumbnail, extracted_dir, "map_update_healthcheck_thumbnail.png")
    lineage_report = default_output(args.lineage_report, extracted_dir, "map_render_lineage_healthcheck_report.json")
    overlay_report = default_output(args.overlay_report, extracted_dir, "overlay_alignment_healthcheck_report.json")
    overlay_diagnostic = default_output(args.overlay_diagnostic, extracted_dir, "overlay_alignment_healthcheck.png")

    checks: list[CheckResult] = []
    try:
        checks.append(py_compile_tools())

        render_stdout = run_command(
            [
                sys.executable,
                str(ROOT / "tools" / "render_map_candidate.py"),
                "--extracted-dir",
                str(extracted_dir),
                "--compare-image",
                str(args.map_image),
                "--output",
                str(render_output),
                "--thumbnail",
                str(render_thumbnail),
                "--layer-rule",
                "client-blueprint",
                "--overworld-qx",
                "0",
                "--overworld-qy",
                "0",
                "--underground-qx",
                "1",
                "--underground-qy",
                "0",
                "--underground-transform",
                "identity",
            ]
        )
        render_metrics = parse_render_metrics(render_stdout)
        checks.extend(
            [
                result(
                    "render exact vs live map",
                    render_metrics["exact_pixels"] >= args.min_render_exact,
                    f"{percent(render_metrics['exact_pixels'])} exact pixels; threshold {percent(args.min_render_exact)}",
                ),
                result(
                    "render mean RGB diff vs live map",
                    render_metrics["mean_rgb_sum_diff"] <= args.max_render_mean_diff,
                    f"{render_metrics['mean_rgb_sum_diff']:.2f} mean RGB sum diff; threshold {args.max_render_mean_diff:.2f}",
                ),
            ]
        )

        run_command(
            [
                sys.executable,
                str(ROOT / "tools" / "analyze_map_render_lineage.py"),
                "--extracted-dir",
                str(extracted_dir),
                "--current-map",
                str(args.map_image),
                "--report",
                str(lineage_report),
            ]
        )
        checks.extend(
            evaluate_lineage_report(
                read_json(lineage_report),
                min_active_exact=args.min_active_exact,
                min_active_iou=args.min_active_iou,
                min_palette_ratio=args.min_palette_ratio,
            )
        )

        run_command(
            [
                sys.executable,
                str(ROOT / "tools" / "check_overlay_alignment.py"),
                "--data-dir",
                str(args.data_dir),
                "--map-image",
                str(args.map_image),
                "--underground-y-mode",
                "direct",
                "--diagnostic",
                str(overlay_diagnostic),
                "--report-json",
                str(overlay_report),
            ]
        )
        checks.extend(
            evaluate_overlay_report(
                read_json(overlay_report),
                max_far_point_px=args.max_far_point_px,
                min_zone_visible_ratio=args.min_zone_visible_ratio,
                min_encounter_visible_ratio=args.min_encounter_visible_ratio,
            )
        )
    except CommandFailed as error:
        print_command_failure(error)
        return 1
    except (KeyError, ValueError) as error:
        print(f"[FAIL] could not evaluate health-check output: {error}")
        return 1

    print("Project Rogue map update health check")
    for item in checks:
        status = "PASS" if item.passed else "FAIL"
        print(f"[{status}] {item.name}: {item.detail}")
    print(f"render: {render_output}")
    print(f"thumbnail: {render_thumbnail}")
    print(f"lineage report: {lineage_report}")
    print(f"overlay report: {overlay_report}")
    print(f"overlay diagnostic: {overlay_diagnostic}")

    return 0 if all(item.passed for item in checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
