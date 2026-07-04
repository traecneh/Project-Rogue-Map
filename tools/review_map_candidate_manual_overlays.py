from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from check_overlay_alignment import (
    CHUNK,
    FLOOR_W,
    IMG_H,
    IMG_W,
    UNDERGROUND_Y_MODES,
    active_underground_chunks,
    changed_activity,
    chunk_coverage,
    collect_encounter_cells,
    collect_points,
    collect_zone_cells,
    nearest_mask_distance,
    point_activity,
)


DEFAULT_EXTRACTED_DIR = Path(".analysis") / "rogue_data_vpack_2026-07-03"
DEFAULT_CANDIDATE = DEFAULT_EXTRACTED_DIR / "Map_Combined_hybrid_current_overworld_vpack_q01_l0.png"
DEFAULT_REVIEW_SHEET = DEFAULT_EXTRACTED_DIR / "manual_overlay_candidate_review_sheet.png"
DEFAULT_REPORT = DEFAULT_EXTRACTED_DIR / "manual_overlay_candidate_review_report.json"
DEFAULT_CHECKLIST = DEFAULT_EXTRACTED_DIR / "manual_overlay_candidate_review_checklist.md"
PANEL_SIZE = 1024


POINT_COLORS = {
    "caves": (0, 210, 255, 235),
    "portals": (255, 64, 255, 235),
    "portal-labels": (255, 64, 255, 235),
    "towns": (255, 255, 255, 235),
    "poi": (80, 255, 120, 235),
    "crim_spawns": (255, 70, 70, 235),
}


def load_map(path: Path) -> np.ndarray:
    image = np.asarray(Image.open(path).convert("RGB"))
    if image.shape != (IMG_H, IMG_W, 3):
        raise ValueError(f"expected 8192x4096 map image, got {image.shape} from {path}")
    return image


def underground_crop(image: np.ndarray) -> Image.Image:
    return Image.fromarray(image[:, FLOOR_W:], "RGB").resize((PANEL_SIZE, PANEL_SIZE), Image.Resampling.NEAREST)


def underground_point_xy(point: dict) -> tuple[float, float]:
    scale = PANEL_SIZE / FLOOR_W
    return (float(point["x"]) - FLOOR_W) * scale, (IMG_H - float(point["y"])) * scale


def underground_point_xy_for_mode(point: dict, underground_y_mode: str) -> tuple[float, float]:
    scale = PANEL_SIZE / FLOOR_W
    y = float(point["y"]) if underground_y_mode == "direct" else IMG_H - float(point["y"])
    return (float(point["x"]) - FLOOR_W) * scale, y * scale


def underground_chunk_rect(cx: int, cy: int, underground_y_mode: str) -> tuple[float, float, float, float]:
    scale = PANEL_SIZE / FLOOR_W
    x = (cx - (FLOOR_W // CHUNK)) * CHUNK * scale
    y = cy * CHUNK * scale if underground_y_mode == "direct" else (IMG_H - (cy + 1) * CHUNK) * scale
    return x, y, x + CHUNK * scale, y + CHUNK * scale


def draw_label(draw: ImageDraw.ImageDraw, text: str) -> None:
    draw.rectangle([0, 0, PANEL_SIZE, 58], fill=(0, 0, 0, 170))
    draw.text((12, 10), text, fill=(245, 248, 252, 255))


def draw_points(
    image: Image.Image,
    points: list[dict],
    *,
    underground_y_mode: str,
    flagged: set[tuple[str, str, float, float]] | None = None,
    label_flagged: bool = False,
) -> None:
    draw = ImageDraw.Draw(image, "RGBA")
    for point in points:
        if point["floor"] != "underground":
            continue
        x, y = underground_point_xy_for_mode(point, underground_y_mode)
        key = (point["source"], point["name"], float(point["x"]), float(point["y"]))
        color = POINT_COLORS.get(point["source"], (255, 255, 255, 235))
        radius = 6
        outline = (0, 0, 0, 235)
        if flagged and key in flagged:
            color = (255, 52, 52, 240)
            outline = (255, 255, 255, 245)
            radius = 8
        draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=color, outline=outline, width=2)
        if label_flagged and flagged and key in flagged:
            label = point["name"][:26]
            draw.rectangle([x + 9, y - 8, x + 14 + len(label) * 6, y + 8], fill=(0, 0, 0, 165))
            draw.text((x + 12, y - 7), label, fill=(255, 255, 255, 245))


def draw_zone_cells(image: Image.Image, zones: list[dict], encounters: list[dict], *, underground_y_mode: str) -> None:
    draw = ImageDraw.Draw(image, "RGBA")
    for cell in encounters:
        if cell["floor"] == "underground":
            draw.rectangle(underground_chunk_rect(cell["cx"], cell["cy"], underground_y_mode), fill=(255, 0, 255, 26))
    for cell in zones:
        if cell["floor"] == "underground":
            draw.rectangle(underground_chunk_rect(cell["cx"], cell["cy"], underground_y_mode), outline=(255, 180, 0, 95), width=1)


def make_diff_panel(current: np.ndarray, candidate: np.ndarray) -> Image.Image:
    current_under = current[:, FLOOR_W:]
    candidate_under = candidate[:, FLOOR_W:]
    current_active = (current_under != 0).any(axis=2)
    candidate_active = (candidate_under != 0).any(axis=2)
    both = current_active & candidate_active
    removed = current_active & ~candidate_active
    added = candidate_active & ~current_active

    diff = np.zeros((IMG_H, FLOOR_W, 3), dtype=np.uint8)
    diff[both] = (72, 72, 72)
    diff[removed] = (220, 60, 60)
    diff[added] = (68, 160, 240)
    return Image.fromarray(diff, "RGB").resize((PANEL_SIZE, PANEL_SIZE), Image.Resampling.NEAREST)


def point_review(current: np.ndarray, candidate: np.ndarray, points: list[dict], *, underground_y_mode: str) -> list[dict]:
    current_mask = (current != 0).any(axis=2)
    candidate_mask = (candidate != 0).any(axis=2)
    rows = []
    for point in points:
        if point["floor"] != "underground":
            continue
        current_active, current_total = point_activity(
            current,
            point["x"],
            point["y"],
            radius=4,
            underground_y_mode=underground_y_mode,
        )
        candidate_active, candidate_total = point_activity(
            candidate,
            point["x"],
            point["y"],
            radius=4,
            underground_y_mode=underground_y_mode,
        )
        changed, changed_total = changed_activity(
            current,
            candidate,
            point["x"],
            point["y"],
            radius=12,
            underground_y_mode=underground_y_mode,
        )
        nearest_current = nearest_mask_distance(
            current_mask,
            point["x"],
            point["y"],
            max_radius=192,
            underground_y_mode=underground_y_mode,
        )
        nearest_candidate = nearest_mask_distance(
            candidate_mask,
            point["x"],
            point["y"],
            max_radius=512,
            underground_y_mode=underground_y_mode,
        )
        needs_review = nearest_candidate is None or nearest_candidate > 24 or candidate_active == 0
        rows.append(
            {
                **point,
                "current_active_pixels_radius4": current_active,
                "current_sample_pixels_radius4": current_total,
                "candidate_active_pixels_radius4": candidate_active,
                "candidate_sample_pixels_radius4": candidate_total,
                "changed_pixels_radius12": changed,
                "changed_sample_pixels_radius12": changed_total,
                "nearest_current_visible_pixel": nearest_current,
                "nearest_candidate_visible_pixel": nearest_candidate,
                "needs_manual_review": needs_review,
            }
        )
    return rows


def make_review_sheet(
    current: np.ndarray,
    candidate: np.ndarray,
    points: list[dict],
    zones: list[dict],
    encounters: list[dict],
    review_rows: list[dict],
    output: Path,
    *,
    underground_y_mode: str,
) -> None:
    flagged = {
        (row["source"], row["name"], float(row["x"]), float(row["y"]))
        for row in review_rows
        if row["needs_manual_review"]
    }

    panels = []

    current_panel = underground_crop(current)
    draw_points(current_panel, points, underground_y_mode=underground_y_mode)
    draw_label(ImageDraw.Draw(current_panel, "RGBA"), "Current underground + manual point overlays")
    panels.append(current_panel)

    candidate_panel = underground_crop(candidate)
    draw_points(candidate_panel, points, underground_y_mode=underground_y_mode)
    draw_label(ImageDraw.Draw(candidate_panel, "RGBA"), "VPACK candidate underground + manual point overlays")
    panels.append(candidate_panel)

    zone_panel = underground_crop(candidate)
    draw_zone_cells(zone_panel, zones, encounters, underground_y_mode=underground_y_mode)
    draw_points(
        zone_panel,
        points,
        underground_y_mode=underground_y_mode,
        flagged=flagged,
        label_flagged=True,
    )
    draw_label(ImageDraw.Draw(zone_panel, "RGBA"), "Candidate with manual zones/encounters; red points need review")
    panels.append(zone_panel)

    diff_panel = make_diff_panel(current, candidate)
    draw_label(ImageDraw.Draw(diff_panel, "RGBA"), "Active terrain diff: red=current only, blue=candidate only, gray=both")
    panels.append(diff_panel)

    canvas = Image.new("RGB", (PANEL_SIZE * 2, PANEL_SIZE * 2), (12, 14, 16))
    for idx, panel in enumerate(panels):
        x = (idx % 2) * PANEL_SIZE
        y = (idx // 2) * PANEL_SIZE
        canvas.paste(panel.convert("RGB"), (x, y))

    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Review manual overlays against a non-live Project Rogue map candidate.")
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    parser.add_argument("--current-map", type=Path, default=Path("img") / "Map_Combined.png")
    parser.add_argument("--candidate-map", type=Path, default=DEFAULT_CANDIDATE)
    parser.add_argument("--review-sheet", type=Path, default=DEFAULT_REVIEW_SHEET)
    parser.add_argument("--report-json", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--review-checklist", type=Path, default=DEFAULT_CHECKLIST)
    parser.add_argument(
        "--underground-y-mode",
        choices=UNDERGROUND_Y_MODES,
        default="invert",
        help="Use invert for app INVERT_Y coordinates or direct when underground map pixels use game Y directly.",
    )
    return parser.parse_args()


def point_sort_key(row: dict) -> tuple:
    distance = 9999 if row["nearest_candidate_visible_pixel"] is None else row["nearest_candidate_visible_pixel"]
    return (0 if row["needs_manual_review"] else 1, -distance, row["source"], row["name"])


def source_file(source: str) -> str:
    if source in {"portals", "portal-labels"}:
        return "data/portals.json"
    return f"data/{source}.json"


def distance_text(value: int | None) -> str:
    return "none within scan" if value is None else str(value)


def write_review_checklist(report: dict, output: Path) -> None:
    points = report["underground_point_review"]
    flagged = [row for row in points if row["needs_manual_review"]]
    accepted = [row for row in points if not row["needs_manual_review"]]
    coverage = report["candidate_underground_chunk_coverage"]
    zones = coverage["zones"]
    encounters = coverage["encounters"]
    point_summary = report["manual_underground_points"]

    lines = [
        "# Manual Overlay Review Checklist",
        "",
        "Generated from the non-live map candidate review. Do not auto-edit the manual JSON from this file; use it as a targeted in-game/map review list.",
        "",
        "## Candidate",
        "",
        f"- Current map: `{report['current_map']}`",
        f"- Candidate map: `{report['candidate_map']}`",
        f"- Underground Y mode: `{report['underground_y_mode']}`",
        f"- Review sheet: `{report['review_sheet']}`",
        f"- Underground changed pixels: `{report['underground_changed_pixels']}` ({report['underground_changed_pixel_ratio']:.1%})",
        "",
        "## Summary",
        "",
        f"- Manual underground points needing review: `{point_summary['needs_manual_review']}/{point_summary['total']}`",
        f"- Zone chunks with visible candidate pixels: `{zones['with_visible_pixels']}/{zones['total']}`",
        f"- Encounter chunks with visible candidate pixels: `{encounters['with_visible_pixels']}/{encounters['total']}`",
        f"- Candidate active underground chunks: `{coverage['active_chunks']}`",
        "",
        "## Points Needing Manual Review",
        "",
        "| Source file | Marker | X | Y | Nearest candidate pixel | Candidate active r4 | Current nearest pixel |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]

    for row in flagged:
        lines.append(
            "| "
            f"`{source_file(row['source'])}` | "
            f"{row['name']} | "
            f"{row['x']:.0f} | "
            f"{row['y']:.0f} | "
            f"{distance_text(row['nearest_candidate_visible_pixel'])} | "
            f"{row['candidate_active_pixels_radius4']} | "
            f"{distance_text(row['nearest_current_visible_pixel'])} |"
        )

    lines.extend(
        [
            "",
            "## Points Already Landing On Candidate Terrain",
            "",
            "| Source file | Marker | X | Y | Nearest candidate pixel | Candidate active r4 |",
            "|---|---:|---:|---:|---:|---:|",
        ]
    )
    for row in accepted:
        lines.append(
            "| "
            f"`{source_file(row['source'])}` | "
            f"{row['name']} | "
            f"{row['x']:.0f} | "
            f"{row['y']:.0f} | "
            f"{distance_text(row['nearest_candidate_visible_pixel'])} | "
            f"{row['candidate_active_pixels_radius4']} |"
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    current = load_map(args.current_map)
    candidate = load_map(args.candidate_map)
    points = collect_points(args.data_dir)
    zones = collect_zone_cells(args.data_dir)
    encounters = collect_encounter_cells(args.data_dir)

    review_rows = point_review(current, candidate, points, underground_y_mode=args.underground_y_mode)
    candidate_mask = (candidate != 0).any(axis=2)
    candidate_active_chunks = active_underground_chunks(candidate_mask, underground_y_mode=args.underground_y_mode)
    zone_coverage = chunk_coverage(candidate_mask, zones, underground_y_mode=args.underground_y_mode)
    encounter_coverage = chunk_coverage(candidate_mask, encounters, underground_y_mode=args.underground_y_mode)
    changed_under = (current[:, FLOOR_W:] != candidate[:, FLOOR_W:]).any(axis=2)

    report = {
        "current_map": str(args.current_map),
        "candidate_map": str(args.candidate_map),
        "underground_y_mode": args.underground_y_mode,
        "review_sheet": str(args.review_sheet),
        "underground_changed_pixels": int(changed_under.sum()),
        "underground_changed_pixel_ratio": float(changed_under.mean()),
        "manual_underground_points": {
            "total": len(review_rows),
            "needs_manual_review": sum(1 for row in review_rows if row["needs_manual_review"]),
            "by_source": {
                source: sum(1 for row in review_rows if row["source"] == source)
                for source in sorted({row["source"] for row in review_rows})
            },
        },
        "underground_point_review": sorted(
            review_rows,
            key=point_sort_key,
        ),
        "candidate_underground_chunk_coverage": {
            "active_chunks": len(candidate_active_chunks),
            "zones": zone_coverage,
            "encounters": encounter_coverage,
        },
    }

    args.report_json.parent.mkdir(parents=True, exist_ok=True)
    args.report_json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    make_review_sheet(
        current,
        candidate,
        points,
        zones,
        encounters,
        review_rows,
        args.review_sheet,
        underground_y_mode=args.underground_y_mode,
    )
    write_review_checklist(report, args.review_checklist)

    print(f"review_sheet: {args.review_sheet}")
    print(f"report_json: {args.report_json}")
    print(f"review_checklist: {args.review_checklist}")
    print(
        "manual underground points needing review: "
        f"{report['manual_underground_points']['needs_manual_review']}/{report['manual_underground_points']['total']}"
    )
    print(
        "candidate zone chunk coverage: "
        f"{zone_coverage['with_visible_pixels']}/{zone_coverage['total']} chunks with visible pixels"
    )
    print(f"underground changed pixels: {report['underground_changed_pixels']} ({report['underground_changed_pixel_ratio']:.1%})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
