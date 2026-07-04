from __future__ import annotations

import argparse
import base64
import json
from collections import Counter
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image, ImageDraw

from render_map_candidate import load_map_arrays, load_tile_rgb_palette


DEFAULT_EXTRACTED_DIR = Path(".analysis") / "rogue_data_vpack_2026-07-03"
DEFAULT_DATA_DIR = Path("data")
CHUNK = 16
PAGE_CHUNKS = 256
DIAGNOSTIC_SIZE = 1024

TRANSFORM_NAMES = (
    "identity",
    "flip_x",
    "flip_y",
    "flip_xy",
    "swap",
    "swap_flip_x",
    "swap_flip_y",
    "swap_flip_xy",
)


def read_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def collect_zone_cells(data_dir: Path) -> tuple[set[tuple[int, int]], set[tuple[int, int]]]:
    zones = read_json(data_dir / "zones.json").get("zones", [])
    overworld: set[tuple[int, int]] = set()
    underground: set[tuple[int, int]] = set()
    for zone in zones:
        for cell in zone.get("cells", []):
            if not isinstance(cell, list) or len(cell) < 2:
                continue
            cx, cy = int(cell[0]), int(cell[1])
            if cx >= PAGE_CHUNKS:
                underground.add((cx - PAGE_CHUNKS, cy))
            else:
                overworld.add((cx, cy))
    return overworld, underground


def collect_encounter_cells(data_dir: Path) -> tuple[set[tuple[int, int]], set[tuple[int, int]]]:
    encounters = read_json(data_dir / "encounters.json")
    overworld: set[tuple[int, int]] = set()
    underground: set[tuple[int, int]] = set()
    for key in encounters:
        try:
            cx_s, cy_s = key.split(",", 1)
            cx, cy = int(cx_s), int(cy_s)
        except ValueError:
            continue
        if cx >= PAGE_CHUNKS:
            underground.add((cx - PAGE_CHUNKS, cy))
        else:
            overworld.add((cx, cy))
    return overworld, underground


def build_chunk_activity(chunks: np.ndarray, colors: np.ndarray) -> np.ndarray:
    tile_active = (colors != 0).any(axis=1)
    return tile_active[chunks].any(axis=(2, 3))


def page_active_chunks(
    chunk_map: np.ndarray,
    chunk_active: np.ndarray,
    *,
    qx: int,
    qy: int,
    layer: int,
) -> set[tuple[int, int]]:
    ids = chunk_map[qx * PAGE_CHUNKS : (qx + 1) * PAGE_CHUNKS, qy * PAGE_CHUNKS : (qy + 1) * PAGE_CHUNKS]
    mask = chunk_active[layer, ids]
    xs, ys = np.nonzero(mask)
    return {(int(x), int(PAGE_CHUNKS - 1 - y)) for x, y in zip(xs, ys)}


def transform_point(point: tuple[int, int], transform: str) -> tuple[int, int]:
    x, y = point
    if transform == "identity":
        return x, y
    if transform == "flip_x":
        return PAGE_CHUNKS - 1 - x, y
    if transform == "flip_y":
        return x, PAGE_CHUNKS - 1 - y
    if transform == "flip_xy":
        return PAGE_CHUNKS - 1 - x, PAGE_CHUNKS - 1 - y
    if transform == "swap":
        return y, x
    if transform == "swap_flip_x":
        return PAGE_CHUNKS - 1 - y, x
    if transform == "swap_flip_y":
        return y, PAGE_CHUNKS - 1 - x
    if transform == "swap_flip_xy":
        return PAGE_CHUNKS - 1 - y, PAGE_CHUNKS - 1 - x
    raise ValueError(f"unknown transform: {transform}")


def transform_cells(cells: Iterable[tuple[int, int]], transform: str) -> set[tuple[int, int]]:
    transformed: set[tuple[int, int]] = set()
    for point in cells:
        x, y = transform_point(point, transform)
        if 0 <= x < PAGE_CHUNKS and 0 <= y < PAGE_CHUNKS:
            transformed.add((x, y))
    return transformed


def score_cells(source: set[tuple[int, int]], target: set[tuple[int, int]]) -> dict:
    overlap = len(source & target)
    union = len(source | target)
    return {
        "source_cells": len(source),
        "target_cells": len(target),
        "overlap_cells": overlap,
        "iou": overlap / union if union else 0.0,
        "source_coverage": overlap / len(source) if source else 0.0,
        "target_coverage": overlap / len(target) if target else 0.0,
    }


def transform_scores(source: set[tuple[int, int]], target: set[tuple[int, int]]) -> list[dict]:
    scores = []
    for transform in TRANSFORM_NAMES:
        mapped = transform_cells(source, transform)
        score = score_cells(mapped, target)
        score["transform"] = transform
        scores.append(score)
    return sorted(scores, key=lambda item: (item["overlap_cells"], item["iou"]), reverse=True)


def best_offsets(
    source: set[tuple[int, int]],
    target: set[tuple[int, int]],
    *,
    max_abs: int = 96,
    limit: int = 8,
) -> list[dict]:
    counts: Counter[tuple[int, int]] = Counter()
    target_points = list(target)
    for x, y in source:
        for tx, ty in target_points:
            dx = tx - x
            dy = ty - y
            if -max_abs <= dx <= max_abs and -max_abs <= dy <= max_abs:
                counts[(dx, dy)] += 1

    rows = []
    for (dx, dy), overlap in counts.most_common(limit * 4):
        moved_count = sum(1 for x, y in source if 0 <= x + dx < PAGE_CHUNKS and 0 <= y + dy < PAGE_CHUNKS)
        rows.append(
            {
                "dx": dx,
                "dy": dy,
                "overlap_cells": overlap,
                "moved_cells_in_bounds": moved_count,
                "source_coverage": overlap / len(source) if source else 0.0,
                "target_coverage": overlap / len(target) if target else 0.0,
            }
        )
    return sorted(rows, key=lambda item: item["overlap_cells"], reverse=True)[:limit]


def decode_grid(grid_json: dict) -> np.ndarray:
    raw_b64 = grid_json.get("grid")
    if isinstance(raw_b64, dict):
        raw_b64 = raw_b64["data"]
    raw = base64.b64decode(raw_b64)
    return np.frombuffer(raw, dtype="<i2").reshape(int(grid_json["height"]), int(grid_json["width"]))


def grid_nonzero_by_page(grid_json: dict) -> tuple[dict[tuple[int, int], set[tuple[int, int]]], Counter[int]]:
    grid = decode_grid(grid_json)
    pages: dict[tuple[int, int], set[tuple[int, int]]] = {}
    ids: Counter[int] = Counter(int(value) for value in grid.ravel() if int(value) != 0)
    ys, xs = np.nonzero(grid)
    for y, x in zip(ys, xs):
        page = (int(x) // PAGE_CHUNKS, int(y) // PAGE_CHUNKS)
        local = (int(x) % PAGE_CHUNKS, PAGE_CHUNKS - 1 - (int(y) % PAGE_CHUNKS))
        pages.setdefault(page, set()).add(local)
    return pages, ids


def page_key(page: tuple[int, int], layer: int) -> str:
    return f"q({page[0]},{page[1]})/layer{layer}"


def draw_diagnostic(
    output: Path,
    active: set[tuple[int, int]],
    source: set[tuple[int, int]],
    best_transform: str,
) -> None:
    scale = DIAGNOSTIC_SIZE / PAGE_CHUNKS
    image = Image.new("RGBA", (DIAGNOSTIC_SIZE, DIAGNOSTIC_SIZE), (10, 12, 14, 255))
    draw = ImageDraw.Draw(image, "RGBA")

    def rect(cell: tuple[int, int]) -> tuple[float, float, float, float]:
        x, y = cell
        left = x * scale
        top = (PAGE_CHUNKS - 1 - y) * scale
        return left, top, left + scale, top + scale

    for cell in active:
        draw.rectangle(rect(cell), fill=(52, 93, 122, 210))

    identity = transform_cells(source, "identity")
    for cell in identity:
        draw.rectangle(rect(cell), outline=(235, 72, 105, 110), width=1)

    transformed = transform_cells(source, best_transform)
    for cell in transformed:
        fill = (86, 200, 116, 210) if cell in active else (245, 169, 64, 145)
        draw.rectangle(rect(cell), fill=fill)

    draw.text((12, 10), "q(1,0) layer0 active chunks", fill=(220, 230, 238, 255))
    draw.text((12, 30), "orange: best-transformed old zones, green: overlap", fill=(220, 230, 238, 255))
    draw.text((12, 50), "pink outline: old underground zones in current display coords", fill=(220, 230, 238, 255))

    output.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(output)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Analyze Project Rogue VPACK map and overlay coordinate alignment.")
    parser.add_argument("--extracted-dir", type=Path, default=DEFAULT_EXTRACTED_DIR)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--output-report", type=Path, default=None)
    parser.add_argument("--output-diagnostic", type=Path, default=None)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    extracted_dir = args.extracted_dir
    output_report = args.output_report or extracted_dir / "vpack_coordinate_mapping_report.json"
    output_diagnostic = args.output_diagnostic or extracted_dir / "vpack_coordinate_mapping_q10_transform_diagnostic.png"

    map_meta, chunk_map, chunks = load_map_arrays(extracted_dir / "map.json")
    colors = load_tile_rgb_palette(extracted_dir / "tiles.json")
    chunk_active = build_chunk_activity(chunks, colors)

    zone_over, zone_under = collect_zone_cells(args.data_dir)
    encounter_over, encounter_under = collect_encounter_cells(args.data_dir)

    active_by_page_layer: dict[tuple[tuple[int, int], int], set[tuple[int, int]]] = {}
    for layer in range(int(map_meta["layer_count"])):
        for page in ((0, 0), (1, 0), (0, 1), (1, 1)):
            active_by_page_layer[(page, layer)] = page_active_chunks(
                chunk_map,
                chunk_active,
                qx=page[0],
                qy=page[1],
                layer=layer,
            )

    q00_layer0 = active_by_page_layer[((0, 0), 0)]
    q10_layer0 = active_by_page_layer[((1, 0), 0)]
    underground_zone_scores = transform_scores(zone_under, q10_layer0)
    underground_encounter_scores = transform_scores(encounter_under, q10_layer0)
    best_zone_transform = underground_zone_scores[0]["transform"]

    grid_report = {}
    for name in ("locales", "safezones"):
        pages, ids = grid_nonzero_by_page(read_json(extracted_dir / f"{name}.json"))
        page_report = {}
        for page, cells in sorted(pages.items()):
            overlaps = {}
            for layer in range(int(map_meta["layer_count"])):
                active = active_by_page_layer.get((page, layer))
                if active is not None:
                    overlaps[f"layer{layer}"] = score_cells(cells, active)
            page_report[f"q({page[0]},{page[1]})"] = {
                "cells": len(cells),
                "active_overlaps": overlaps,
            }
        grid_report[name] = {
            "nonzero_total": sum(ids.values()),
            "top_ids": [{"id": key, "cells": value} for key, value in ids.most_common(12)],
            "pages": page_report,
        }

    report = {
        "source": {
            "extracted_dir": str(extracted_dir),
            "map_generated_at": map_meta.get("generated_at"),
            "data_dir": str(args.data_dir),
        },
        "data_counts": {
            "zone_overworld_cells": len(zone_over),
            "zone_underground_cells": len(zone_under),
            "encounter_overworld_cells": len(encounter_over),
            "encounter_underground_cells": len(encounter_under),
        },
        "active_chunks": {
            page_key(page, layer): len(cells)
            for (page, layer), cells in sorted(active_by_page_layer.items(), key=lambda item: (item[0][1], item[0][0]))
        },
        "old_overworld_against_q00": {
            "zones_layer0": score_cells(zone_over, q00_layer0),
            "encounters_layer0": score_cells(encounter_over, q00_layer0),
            "zones_layer1": score_cells(zone_over, active_by_page_layer[((0, 0), 1)]),
            "encounters_layer1": score_cells(encounter_over, active_by_page_layer[((0, 0), 1)]),
        },
        "old_underground_against_q10_layer0": {
            "zones_transform_scores": underground_zone_scores,
            "encounters_transform_scores": underground_encounter_scores,
            "zones_best_offsets_by_transform": {
                transform: best_offsets(transform_cells(zone_under, transform), q10_layer0, limit=3)
                for transform in TRANSFORM_NAMES
            },
        },
        "vpack_grids": grid_report,
        "conclusion": {
            "best_old_underground_zone_transform": best_zone_transform,
            "best_old_underground_zone_overlap": underground_zone_scores[0]["overlap_cells"],
            "best_old_underground_zone_source_coverage": underground_zone_scores[0]["source_coverage"],
            "best_old_underground_zone_target_coverage": underground_zone_scores[0]["target_coverage"],
            "interpretation": (
                "The manual underground overlays partially match q(1,0) layer0 only after a swap/flip transform. "
                "Coverage is too low for an automatic remap, so keep the manual overlay JSON as the source of truth "
                "and adjust it by hand only where the rendered game map has changed."
            ),
        },
    }

    output_report.parent.mkdir(parents=True, exist_ok=True)
    with output_report.open("w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
        handle.write("\n")

    draw_diagnostic(output_diagnostic, q10_layer0, zone_under, best_zone_transform)

    print(f"map generated_at: {map_meta.get('generated_at')}")
    print(f"active q(1,0)/layer0 chunks: {len(q10_layer0)}")
    print(
        "best old underground zone transform: "
        f"{best_zone_transform} "
        f"({underground_zone_scores[0]['overlap_cells']}/{len(zone_under)} old cells overlap, "
        f"{underground_zone_scores[0]['target_coverage']:.1%} of active chunks)"
    )
    print(f"report: {output_report}")
    print(f"diagnostic: {output_diagnostic}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
