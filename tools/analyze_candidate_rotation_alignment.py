from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from check_overlay_alignment import CHUNK, FLOOR_W, IMG_H, IMG_W, collect_encounter_cells, collect_points, collect_zone_cells


DEFAULT_EXTRACTED_DIR = Path(".analysis") / "rogue_data_vpack_2026-07-03"
DEFAULT_CANDIDATE = DEFAULT_EXTRACTED_DIR / "Map_Combined_hybrid_current_overworld_vpack_q01_l0.png"
DEFAULT_REPORT = DEFAULT_EXTRACTED_DIR / "candidate_rotation_alignment_report.json"
DEFAULT_SHEET = DEFAULT_EXTRACTED_DIR / "candidate_rotation_alignment_variants.png"
DEFAULT_BEST_MAP = DEFAULT_EXTRACTED_DIR / "Map_Combined_hybrid_current_overworld_vpack_q01_l0_best_rotation.png"
PAGE_CHUNKS = 256
PANEL_SIZE = 768


ORTHOGONAL_TRANSFORMS = (
    "identity",
    "rot90_cw",
    "rot90_ccw",
    "rot180",
    "flip_x",
    "flip_y",
    "transpose",
    "anti_transpose",
)


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


def chunk_mask_from_underground(image: np.ndarray) -> np.ndarray:
    active = (image != 0).any(axis=2)
    return active.reshape(PAGE_CHUNKS, CHUNK, PAGE_CHUNKS, CHUNK).any(axis=(1, 3))


def transform_array(arr: np.ndarray, transform: str) -> np.ndarray:
    if transform == "identity":
        return arr
    if transform == "rot90_cw":
        return np.rot90(arr, k=3)
    if transform == "rot90_ccw":
        return np.rot90(arr, k=1)
    if transform == "rot180":
        return np.rot90(arr, k=2)
    if transform == "flip_x":
        return np.fliplr(arr)
    if transform == "flip_y":
        return np.flipud(arr)
    if transform == "transpose":
        axes = (1, 0, 2) if arr.ndim == 3 else (1, 0)
        return np.transpose(arr, axes)
    if transform == "anti_transpose":
        axes = (1, 0, 2) if arr.ndim == 3 else (1, 0)
        return np.flipud(np.fliplr(np.transpose(arr, axes)))
    raise ValueError(f"unknown transform: {transform}")


def rotate_mask(mask: np.ndarray, angle: int) -> np.ndarray:
    image = Image.fromarray((mask.astype(np.uint8) * 255), "L")
    rotated = image.rotate(angle, resample=Image.Resampling.NEAREST, expand=False, fillcolor=0)
    return np.asarray(rotated) != 0


def rotate_underground(image: np.ndarray, angle: int) -> np.ndarray:
    rotated = Image.fromarray(image, "RGB").rotate(
        angle,
        resample=Image.Resampling.NEAREST,
        expand=False,
        fillcolor=(0, 0, 0),
    )
    return np.asarray(rotated)


def manual_chunk_masks(data_dir: Path) -> tuple[np.ndarray, np.ndarray]:
    zone_mask = np.zeros((PAGE_CHUNKS, PAGE_CHUNKS), dtype=bool)
    encounter_mask = np.zeros((PAGE_CHUNKS, PAGE_CHUNKS), dtype=bool)

    for cell in collect_zone_cells(data_dir):
        if cell["floor"] == "underground":
            col = int(cell["cx"]) - PAGE_CHUNKS
            row = PAGE_CHUNKS - 1 - int(cell["cy"])
            if 0 <= row < PAGE_CHUNKS and 0 <= col < PAGE_CHUNKS:
                zone_mask[row, col] = True

    for cell in collect_encounter_cells(data_dir):
        if cell["floor"] == "underground":
            col = int(cell["cx"]) - PAGE_CHUNKS
            row = PAGE_CHUNKS - 1 - int(cell["cy"])
            if 0 <= row < PAGE_CHUNKS and 0 <= col < PAGE_CHUNKS:
                encounter_mask[row, col] = True

    return zone_mask, encounter_mask


def point_chunks(data_dir: Path) -> list[dict]:
    chunks = []
    for point in collect_points(data_dir):
        if point["floor"] != "underground":
            continue
        local_x = float(point["x"]) - FLOOR_W
        pixel_y = IMG_H - float(point["y"])
        col = int(local_x // CHUNK)
        row = int(pixel_y // CHUNK)
        if 0 <= row < PAGE_CHUNKS and 0 <= col < PAGE_CHUNKS:
            chunks.append({**point, "row": row, "col": col})
    return chunks


def nearest_chunk_distance(mask: np.ndarray, row: int, col: int) -> int | None:
    rows, cols = np.nonzero(mask)
    if rows.size == 0:
        return None
    return int(np.maximum(np.abs(rows - row), np.abs(cols - col)).min())


def score_mask(mask: np.ndarray, zone_mask: np.ndarray, encounter_mask: np.ndarray, points: list[dict]) -> dict:
    active_count = int(mask.sum())
    zone_overlap = int((mask & zone_mask).sum())
    encounter_overlap = int((mask & encounter_mask).sum())
    point_hits = sum(1 for point in points if mask[point["row"], point["col"]])
    point_distances = [nearest_chunk_distance(mask, point["row"], point["col"]) for point in points]
    numeric_distances = np.asarray([distance for distance in point_distances if distance is not None], dtype=np.float32)
    return {
        "active_chunks": active_count,
        "zone_overlap": zone_overlap,
        "zone_total": int(zone_mask.sum()),
        "zone_source_coverage": zone_overlap / int(zone_mask.sum()) if zone_mask.any() else 0.0,
        "zone_active_coverage": zone_overlap / active_count if active_count else 0.0,
        "encounter_overlap": encounter_overlap,
        "encounter_total": int(encounter_mask.sum()),
        "encounter_source_coverage": encounter_overlap / int(encounter_mask.sum()) if encounter_mask.any() else 0.0,
        "manual_point_hits": int(point_hits),
        "manual_point_total": len(points),
        "manual_point_hit_rate": point_hits / len(points) if points else 0.0,
        "manual_point_distance_p50_chunks": float(np.percentile(numeric_distances, 50)) if numeric_distances.size else None,
        "manual_point_distance_p90_chunks": float(np.percentile(numeric_distances, 90)) if numeric_distances.size else None,
        "manual_point_distance_max_chunks": int(numeric_distances.max()) if numeric_distances.size else None,
    }


def best_offset(mask: np.ndarray, target: np.ndarray, *, max_offset: int = 40) -> dict:
    best = {"dx": 0, "dy": 0, "overlap": int((mask & target).sum()), "max_offset": max_offset}
    for dy in range(-max_offset, max_offset + 1):
        for dx in range(-max_offset, max_offset + 1):
            shifted = np.zeros_like(mask)
            src_y0 = max(0, -dy)
            src_y1 = min(PAGE_CHUNKS, PAGE_CHUNKS - dy)
            dst_y0 = max(0, dy)
            dst_y1 = min(PAGE_CHUNKS, PAGE_CHUNKS + dy)
            src_x0 = max(0, -dx)
            src_x1 = min(PAGE_CHUNKS, PAGE_CHUNKS - dx)
            dst_x0 = max(0, dx)
            dst_x1 = min(PAGE_CHUNKS, PAGE_CHUNKS + dx)
            if src_y0 >= src_y1 or src_x0 >= src_x1:
                continue
            shifted[dst_y0:dst_y1, dst_x0:dst_x1] = mask[src_y0:src_y1, src_x0:src_x1]
            overlap = int((shifted & target).sum())
            if overlap > best["overlap"]:
                best = {"dx": dx, "dy": dy, "overlap": overlap, "max_offset": max_offset}
    return best


def score_with_current(score: dict, mask: np.ndarray, current_mask: np.ndarray) -> dict:
    current_overlap = int((mask & current_mask).sum())
    current_union = int((mask | current_mask).sum())
    score.update(
        {
            "current_active_overlap": current_overlap,
            "current_active_total": int(current_mask.sum()),
            "current_active_iou": current_overlap / current_union if current_union else 0.0,
        }
    )
    return score


def evaluate_transforms(
    candidate_mask: np.ndarray,
    current_mask: np.ndarray,
    zone_mask: np.ndarray,
    encounter_mask: np.ndarray,
    points: list[dict],
) -> tuple[list[dict], list[dict]]:
    orthogonal = []
    for name in ORTHOGONAL_TRANSFORMS:
        mask = transform_array(candidate_mask, name)
        score = score_mask(mask, zone_mask, encounter_mask, points)
        score = score_with_current(score, mask, current_mask)
        score["kind"] = "orthogonal"
        score["transform"] = name
        score["best_zone_offset"] = best_offset(mask, zone_mask, max_offset=40)
        orthogonal.append(score)

    angle_scores = []
    for angle in range(0, 360, 5):
        mask = rotate_mask(candidate_mask, angle)
        score = score_mask(mask, zone_mask, encounter_mask, points)
        score = score_with_current(score, mask, current_mask)
        score["kind"] = "angle"
        score["angle_degrees"] = angle
        if angle % 45 == 0:
            score["best_zone_offset"] = best_offset(mask, zone_mask, max_offset=40)
        angle_scores.append(score)

    sort_key = lambda item: (item["zone_overlap"], item["manual_point_hits"], item["current_active_iou"])
    return sorted(orthogonal, key=sort_key, reverse=True), sorted(angle_scores, key=sort_key, reverse=True)


def apply_variant(image: np.ndarray, variant: dict) -> np.ndarray:
    if variant["kind"] == "orthogonal":
        return transform_array(image, variant["transform"])
    return rotate_underground(image, int(variant["angle_degrees"]))


def draw_overlays(panel: Image.Image, zone_mask: np.ndarray, points: list[dict], transformed_mask: np.ndarray) -> None:
    draw = ImageDraw.Draw(panel, "RGBA")
    scale = PANEL_SIZE / PAGE_CHUNKS

    zone_rows, zone_cols = np.nonzero(zone_mask)
    for row, col in zip(zone_rows, zone_cols):
        x = col * scale
        y = row * scale
        draw.rectangle([x, y, x + scale, y + scale], outline=(255, 180, 0, 85), width=1)

    for point in points:
        x = point["col"] * scale + scale / 2
        y = point["row"] * scale + scale / 2
        hit = transformed_mask[point["row"], point["col"]]
        color = POINT_COLORS.get(point["source"], (255, 255, 255, 235)) if hit else (255, 52, 52, 235)
        radius = 5 if hit else 7
        draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=color, outline=(0, 0, 0, 235), width=1)


def draw_label(panel: Image.Image, lines: list[str]) -> None:
    draw = ImageDraw.Draw(panel, "RGBA")
    height = 16 + 18 * len(lines)
    draw.rectangle([0, 0, PANEL_SIZE, height], fill=(0, 0, 0, 180))
    for idx, line in enumerate(lines):
        draw.text((10, 8 + idx * 18), line, fill=(245, 248, 252, 255))


def variant_label(variant: dict) -> str:
    if variant["kind"] == "orthogonal":
        return str(variant["transform"])
    return f"rotate {variant['angle_degrees']} deg"


def make_variant_sheet(
    current_under: np.ndarray,
    candidate_under: np.ndarray,
    zone_mask: np.ndarray,
    points: list[dict],
    variants: list[dict],
    output: Path,
) -> None:
    panels = []

    current_panel = Image.fromarray(current_under, "RGB").resize((PANEL_SIZE, PANEL_SIZE), Image.Resampling.NEAREST)
    draw_overlays(current_panel, zone_mask, points, chunk_mask_from_underground(current_under))
    draw_label(current_panel, ["Current underground reference", "manual overlays in current display coordinates"])
    panels.append(current_panel)

    for variant in variants[:3]:
        transformed = apply_variant(candidate_under, variant)
        transformed_mask = chunk_mask_from_underground(transformed)
        panel = Image.fromarray(transformed, "RGB").resize((PANEL_SIZE, PANEL_SIZE), Image.Resampling.NEAREST)
        draw_overlays(panel, zone_mask, points, transformed_mask)
        draw_label(
            panel,
            [
                f"Candidate {variant_label(variant)}",
                f"zone overlap {variant['zone_overlap']}/{variant['zone_total']} "
                f"points {variant['manual_point_hits']}/{variant['manual_point_total']}",
                f"current IoU {variant['current_active_iou']:.3f}",
            ],
        )
        panels.append(panel)

    while len(panels) < 4:
        panels.append(Image.new("RGB", (PANEL_SIZE, PANEL_SIZE), (12, 14, 16)))

    canvas = Image.new("RGB", (PANEL_SIZE * 2, PANEL_SIZE * 2), (12, 14, 16))
    for idx, panel in enumerate(panels[:4]):
        canvas.paste(panel.convert("RGB"), ((idx % 2) * PANEL_SIZE, (idx // 2) * PANEL_SIZE))
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Score rotated Project Rogue map candidates against manual overlays.")
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    parser.add_argument("--current-map", type=Path, default=Path("img") / "Map_Combined.png")
    parser.add_argument("--candidate-map", type=Path, default=DEFAULT_CANDIDATE)
    parser.add_argument("--report-json", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--variant-sheet", type=Path, default=DEFAULT_SHEET)
    parser.add_argument("--best-map-output", type=Path, default=DEFAULT_BEST_MAP)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    current = load_map(args.current_map)
    candidate = load_map(args.candidate_map)
    current_under = current[:, FLOOR_W:]
    candidate_under = candidate[:, FLOOR_W:]

    current_mask = chunk_mask_from_underground(current_under)
    candidate_mask = chunk_mask_from_underground(candidate_under)
    zone_mask, encounter_mask = manual_chunk_masks(args.data_dir)
    points = point_chunks(args.data_dir)

    orthogonal, angles = evaluate_transforms(candidate_mask, current_mask, zone_mask, encounter_mask, points)
    cardinal_angles = [score for score in angles if score["angle_degrees"] % 90 == 0]
    diagonal_angles = [score for score in angles if score["angle_degrees"] % 45 == 0 and score["angle_degrees"] % 90 != 0]
    non_cardinal = [score for score in angles if score["angle_degrees"] % 90 != 0]

    preview_variants = []
    for candidate_variant in (
        {"kind": "orthogonal", "transform": "identity", **next(item for item in orthogonal if item["transform"] == "identity")},
        orthogonal[0],
        diagonal_angles[0] if diagonal_angles else non_cardinal[0],
    ):
        key = json.dumps(candidate_variant, sort_keys=True, default=str)
        if key not in {json.dumps(item, sort_keys=True, default=str) for item in preview_variants}:
            preview_variants.append(candidate_variant)

    report = {
        "current_map": str(args.current_map),
        "candidate_map": str(args.candidate_map),
        "best_map_output": str(args.best_map_output),
        "manual_overlay_counts": {
            "underground_zone_chunks": int(zone_mask.sum()),
            "underground_encounter_chunks": int(encounter_mask.sum()),
            "underground_points": len(points),
        },
        "orthogonal_transform_scores": orthogonal,
        "rotation_angle_scores_top15": angles[:15],
        "cardinal_rotation_scores": sorted(cardinal_angles, key=lambda item: item["angle_degrees"]),
        "diagonal_rotation_scores": sorted(diagonal_angles, key=lambda item: item["angle_degrees"]),
        "conclusion": {
            "best_orthogonal": {
                "transform": orthogonal[0]["transform"],
                "zone_overlap": orthogonal[0]["zone_overlap"],
                "zone_total": orthogonal[0]["zone_total"],
                "manual_point_hits": orthogonal[0]["manual_point_hits"],
                "manual_point_total": orthogonal[0]["manual_point_total"],
                "current_active_iou": orthogonal[0]["current_active_iou"],
                "best_zone_offset": orthogonal[0]["best_zone_offset"],
            },
            "best_angle": {
                "angle_degrees": angles[0]["angle_degrees"],
                "zone_overlap": angles[0]["zone_overlap"],
                "zone_total": angles[0]["zone_total"],
                "manual_point_hits": angles[0]["manual_point_hits"],
                "manual_point_total": angles[0]["manual_point_total"],
                "current_active_iou": angles[0]["current_active_iou"],
            },
            "interpretation": (
                "A 90-degree-family rotation/reflection improves chunk overlap compared with the identity candidate, "
                "but the coverage is still far below what a publishable automatic map transform would need. "
                "Use the best variant as a visual clue, not as a live-map replacement."
            ),
        },
    }

    args.report_json.parent.mkdir(parents=True, exist_ok=True)
    args.report_json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    make_variant_sheet(current_under, candidate_under, zone_mask, points, preview_variants, args.variant_sheet)
    best_under = apply_variant(candidate_under, orthogonal[0])
    best_map = np.concatenate([current[:, :FLOOR_W], best_under], axis=1)
    args.best_map_output.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(best_map, "RGB").save(args.best_map_output, optimize=True)

    identity = next(item for item in orthogonal if item["transform"] == "identity")
    print(
        "identity: "
        f"zones={identity['zone_overlap']}/{identity['zone_total']} "
        f"points={identity['manual_point_hits']}/{identity['manual_point_total']} "
        f"current_iou={identity['current_active_iou']:.4f}"
    )
    print(
        "best orthogonal: "
        f"{orthogonal[0]['transform']} zones={orthogonal[0]['zone_overlap']}/{orthogonal[0]['zone_total']} "
        f"points={orthogonal[0]['manual_point_hits']}/{orthogonal[0]['manual_point_total']} "
        f"current_iou={orthogonal[0]['current_active_iou']:.4f}"
    )
    print(
        "best angle: "
        f"{angles[0]['angle_degrees']}deg zones={angles[0]['zone_overlap']}/{angles[0]['zone_total']} "
        f"points={angles[0]['manual_point_hits']}/{angles[0]['manual_point_total']} "
        f"current_iou={angles[0]['current_active_iou']:.4f}"
    )
    if diagonal_angles:
        print(
            "best 45-degree family: "
            f"{diagonal_angles[0]['angle_degrees']}deg zones={diagonal_angles[0]['zone_overlap']}/{diagonal_angles[0]['zone_total']} "
            f"points={diagonal_angles[0]['manual_point_hits']}/{diagonal_angles[0]['manual_point_total']} "
            f"current_iou={diagonal_angles[0]['current_active_iou']:.4f}"
        )
    print(f"report_json: {args.report_json}")
    print(f"variant_sheet: {args.variant_sheet}")
    print(f"best_map_output: {args.best_map_output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
