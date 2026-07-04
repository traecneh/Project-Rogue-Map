from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image, ImageDraw


IMG_W = 8192
IMG_H = 4096
FLOOR_W = 4096
CHUNK = 16
UNDERGROUND_Y_MODES = ("invert", "direct")


def read_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def floor_for_x(x: float) -> str:
    return "underground" if x >= FLOOR_W else "overworld"


def image_xy(x: float, y: float, *, underground_y_mode: str = "invert") -> tuple[int, int]:
    floor = floor_for_x(x)
    image_y = y if floor == "underground" and underground_y_mode == "direct" else IMG_H - y
    return int(round(x)), int(round(image_y))


def in_bounds(x: float, y: float) -> bool:
    return 0 <= x < IMG_W and 0 <= y < IMG_H


def point_activity(
    image: np.ndarray,
    x: float,
    y: float,
    radius: int = 3,
    *,
    underground_y_mode: str = "invert",
) -> tuple[int, int]:
    px, py = image_xy(x, y, underground_y_mode=underground_y_mode)
    x0, x1 = max(0, px - radius), min(IMG_W, px + radius + 1)
    y0, y1 = max(0, py - radius), min(IMG_H, py + radius + 1)
    if x0 >= x1 or y0 >= y1:
        return 0, 0
    patch = image[y0:y1, x0:x1]
    active = (patch != 0).any(axis=2)
    return int(active.sum()), int(active.size)


def changed_activity(
    before: np.ndarray,
    after: np.ndarray,
    x: float,
    y: float,
    radius: int = 3,
    *,
    underground_y_mode: str = "invert",
) -> tuple[int, int]:
    px, py = image_xy(x, y, underground_y_mode=underground_y_mode)
    x0, x1 = max(0, px - radius), min(IMG_W, px + radius + 1)
    y0, y1 = max(0, py - radius), min(IMG_H, py + radius + 1)
    if x0 >= x1 or y0 >= y1:
        return 0, 0
    changed = (before[y0:y1, x0:x1] != after[y0:y1, x0:x1]).any(axis=2)
    return int(changed.sum()), int(changed.size)


def nearest_mask_distance(
    mask: np.ndarray,
    x: float,
    y: float,
    *,
    max_radius: int = 96,
    underground_y_mode: str = "invert",
) -> int | None:
    px, py = image_xy(x, y, underground_y_mode=underground_y_mode)
    if not (0 <= px < IMG_W and 0 <= py < IMG_H):
        return None

    for radius in range(max_radius + 1):
        x0, x1 = max(0, px - radius), min(IMG_W, px + radius + 1)
        y0, y1 = max(0, py - radius), min(IMG_H, py + radius + 1)
        if x0 >= x1 or y0 >= y1:
            continue
        patch = mask[y0:y1, x0:x1]
        if patch.any():
            yy, xx = np.where(patch)
            dx = xx + x0 - px
            dy = yy + y0 - py
            return int(np.sqrt((dx * dx + dy * dy).min()).round())
    return None


def add_point(points: list[dict], source: str, name: str, x: float, y: float) -> None:
    points.append({"source": source, "name": name, "x": float(x), "y": float(y), "floor": floor_for_x(x)})


def iter_portal_endpoints(item: dict) -> Iterable[tuple[str, float, float]]:
    if item.get("entry") and item.get("exit"):
        yield "entry", item["entry"]["x"], item["entry"]["y"]
        yield "exit", item["exit"]["x"], item["exit"]["y"]
    elif item.get("from") and item.get("to"):
        yield "from", item["from"]["x"], item["from"]["y"]
        yield "to", item["to"]["x"], item["to"]["y"]
    elif item.get("a") and item.get("b"):
        yield "a", item["a"]["x"], item["a"]["y"]
        yield "b", item["b"]["x"], item["b"]["y"]
    elif all(key in item for key in ("x1", "y1", "x2", "y2")):
        yield "a", item["x1"], item["y1"]
        yield "b", item["x2"], item["y2"]


def collect_points(data_dir: Path) -> list[dict]:
    points: list[dict] = []

    for item in read_json(data_dir / "caves.json"):
        name = item.get("name", "cave")
        if item.get("entry"):
            add_point(points, "caves", f"{name} entry", item["entry"]["x"], item["entry"]["y"])
        if item.get("exit"):
            add_point(points, "caves", f"{name} exit", item["exit"]["x"], item["exit"]["y"])

    for item in read_json(data_dir / "portals.json"):
        name = item.get("name", "portal")
        for role, x, y in iter_portal_endpoints(item):
            add_point(points, "portals", f"{name} {role}", x, y)
        if "x" in item and "y" in item and item.get("name"):
            add_point(points, "portal-labels", item["name"], item["x"], item["y"])

    for source in ("towns", "poi", "crim_spawns"):
        path = data_dir / f"{source}.json"
        if not path.exists():
            continue
        for item in read_json(path):
            if "x" in item and "y" in item:
                add_point(points, source, item.get("name", source), item["x"], item["y"])

    return points


def collect_zone_cells(data_dir: Path) -> list[dict]:
    zones = read_json(data_dir / "zones.json").get("zones", [])
    cells: list[dict] = []
    seen: set[tuple[int, int]] = set()
    for zone in zones:
        for cell in zone.get("cells", []):
            if not isinstance(cell, list) or len(cell) < 2:
                continue
            cx, cy = int(cell[0]), int(cell[1])
            if (cx, cy) in seen:
                continue
            seen.add((cx, cy))
            cells.append({"cx": cx, "cy": cy, "floor": "underground" if cx >= 256 else "overworld"})
    return cells


def collect_encounter_cells(data_dir: Path) -> list[dict]:
    encounters = read_json(data_dir / "encounters.json")
    cells: list[dict] = []
    for key, names in encounters.items():
        try:
            cx_s, cy_s = key.split(",", 1)
            cx, cy = int(cx_s), int(cy_s)
        except ValueError:
            continue
        cells.append(
            {
                "cx": cx,
                "cy": cy,
                "floor": "underground" if cx >= 256 else "overworld",
                "monsters": len(names) if isinstance(names, list) else 0,
            }
        )
    return cells


def draw_diagnostic(
    map_image: np.ndarray,
    points: list[dict],
    zones: list[dict],
    encounters: list[dict],
    output: Path,
    *,
    underground_y_mode: str = "invert",
) -> None:
    crop = Image.fromarray(map_image[:, FLOOR_W:], "RGB").resize((1024, 1024), Image.Resampling.NEAREST)
    draw = ImageDraw.Draw(crop, "RGBA")
    scale = 1024 / FLOOR_W

    for cell in zones:
        if cell["floor"] != "underground":
            continue
        x = (cell["cx"] - 256) * CHUNK * scale
        y = (
            cell["cy"] * CHUNK * scale
            if underground_y_mode == "direct"
            else (IMG_H - (cell["cy"] + 1) * CHUNK) * scale
        )
        draw.rectangle([x, y, x + CHUNK * scale, y + CHUNK * scale], outline=(255, 180, 0, 75), width=1)

    for cell in encounters:
        if cell["floor"] != "underground":
            continue
        x = (cell["cx"] - 256) * CHUNK * scale
        y = (
            cell["cy"] * CHUNK * scale
            if underground_y_mode == "direct"
            else (IMG_H - (cell["cy"] + 1) * CHUNK) * scale
        )
        draw.rectangle([x, y, x + CHUNK * scale, y + CHUNK * scale], fill=(255, 0, 255, 25))

    colors = {
        "caves": (0, 210, 255, 230),
        "portals": (255, 64, 255, 230),
        "portal-labels": (255, 64, 255, 230),
        "towns": (255, 255, 255, 230),
        "poi": (80, 255, 120, 230),
        "crim_spawns": (255, 70, 70, 230),
    }
    for point in points:
        if point["floor"] != "underground":
            continue
        x = (point["x"] - FLOOR_W) * scale
        y = point["y"] * scale if underground_y_mode == "direct" else (IMG_H - point["y"]) * scale
        color = colors.get(point["source"], (255, 255, 255, 230))
        draw.ellipse([x - 4, y - 4, x + 4, y + 4], fill=color, outline=(0, 0, 0, 230), width=1)

    output.parent.mkdir(parents=True, exist_ok=True)
    crop.save(output)


def chunk_coverage(mask: np.ndarray, cells: list[dict], *, underground_y_mode: str = "invert") -> dict:
    stats = {"total": 0, "with_visible_pixels": 0, "visible_pixels": 0, "area_pixels": 0}
    for cell in cells:
        if cell["floor"] != "underground":
            continue
        x0 = cell["cx"] * CHUNK
        y0 = cell["cy"] * CHUNK if underground_y_mode == "direct" else IMG_H - (cell["cy"] + 1) * CHUNK
        if not (0 <= x0 < IMG_W and 0 <= y0 < IMG_H):
            continue
        patch = mask[y0 : y0 + CHUNK, x0 : x0 + CHUNK]
        visible = int(patch.sum())
        stats["total"] += 1
        stats["visible_pixels"] += visible
        stats["area_pixels"] += int(patch.size)
        if visible:
            stats["with_visible_pixels"] += 1
    return stats


def active_underground_chunks(mask: np.ndarray, *, underground_y_mode: str = "invert") -> set[tuple[int, int]]:
    chunks: set[tuple[int, int]] = set()
    for image_cy in range(IMG_H // CHUNK):
        y0 = image_cy * CHUNK
        cy = image_cy if underground_y_mode == "direct" else (IMG_H // CHUNK) - 1 - image_cy
        for cx in range(256, IMG_W // CHUNK):
            x0 = cx * CHUNK
            if mask[y0 : y0 + CHUNK, x0 : x0 + CHUNK].any():
                chunks.add((cx, cy))
    return chunks


def nearest_chunk_distances(cells: set[tuple[int, int]], active_chunks: set[tuple[int, int]]) -> list[int]:
    if not cells or not active_chunks:
        return []
    active = list(active_chunks)
    distances: list[int] = []
    for cx, cy in cells:
        distances.append(min(max(abs(cx - ax), abs(cy - ay)) for ax, ay in active))
    return distances


def summarize_distances(distances: list[int]) -> dict:
    if not distances:
        return {}
    arr = np.array(distances, dtype=np.int32)
    summary = {f"within_{threshold}_chunks": int((arr <= threshold).sum()) for threshold in (0, 1, 2, 3, 4, 5, 8, 12, 16, 24, 32)}
    summary.update(
        {
            "total": int(arr.size),
            "p50_chunks": float(np.percentile(arr, 50)),
            "p75_chunks": float(np.percentile(arr, 75)),
            "p90_chunks": float(np.percentile(arr, 90)),
            "max_chunks": int(arr.max()),
        }
    )
    return summary


def best_offset_overlap(
    cells: set[tuple[int, int]],
    active_chunks: set[tuple[int, int]],
    *,
    max_offset: int = 40,
) -> dict:
    best = {"overlap": 0, "dx": 0, "dy": 0, "max_offset": max_offset}
    if not cells or not active_chunks:
        return best
    for dx in range(-max_offset, max_offset + 1):
        for dy in range(-max_offset, max_offset + 1):
            overlap = sum((cx + dx, cy + dy) in active_chunks for cx, cy in cells)
            if overlap > best["overlap"]:
                best = {"overlap": int(overlap), "dx": dx, "dy": dy, "max_offset": max_offset}
    return best


def main() -> int:
    parser = argparse.ArgumentParser(description="Check Project Rogue overlay coordinates against the current map image.")
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    parser.add_argument("--map-image", type=Path, default=Path("img") / "Map_Combined.png")
    parser.add_argument("--previous-map", type=Path, default=None)
    parser.add_argument("--diagnostic", type=Path, default=Path(".analysis") / "overlay_underground_alignment.png")
    parser.add_argument("--report-json", type=Path, default=None)
    parser.add_argument(
        "--underground-y-mode",
        choices=UNDERGROUND_Y_MODES,
        default="invert",
        help="Use invert for app INVERT_Y coordinates or direct when underground map pixels use game Y directly.",
    )
    args = parser.parse_args()

    map_image = np.asarray(Image.open(args.map_image).convert("RGB"))
    if map_image.shape != (IMG_H, IMG_W, 3):
        raise ValueError(f"expected 8192x4096 map image, got {map_image.shape}")

    previous = np.asarray(Image.open(args.previous_map).convert("RGB")) if args.previous_map else None
    active_mask = (map_image != 0).any(axis=2)
    changed_mask = (previous != map_image).any(axis=2) if previous is not None else None
    points = collect_points(args.data_dir)
    zones = collect_zone_cells(args.data_dir)
    encounters = collect_encounter_cells(args.data_dir)

    print("point overlays by source/floor")
    for key, value in sorted(Counter((p["source"], p["floor"]) for p in points).items()):
        print(f"  {key[0]:13s} {key[1]:11s} {value}")

    print("chunk overlays by source/floor")
    for label, cells in (("zones", zones), ("encounters", encounters)):
        for floor, value in sorted(Counter(c["floor"] for c in cells).items()):
            print(f"  {label:13s} {floor:11s} {value}")

    invalid = [p for p in points if not in_bounds(p["x"], p["y"])]
    invalid += [
        {"source": "zones", "name": f"{c['cx']},{c['cy']}", "x": c["cx"] * CHUNK, "y": c["cy"] * CHUNK}
        for c in zones
        if not (0 <= c["cx"] < IMG_W // CHUNK and 0 <= c["cy"] < IMG_H // CHUNK)
    ]
    invalid += [
        {"source": "encounters", "name": f"{c['cx']},{c['cy']}", "x": c["cx"] * CHUNK, "y": c["cy"] * CHUNK}
        for c in encounters
        if not (0 <= c["cx"] < IMG_W // CHUNK and 0 <= c["cy"] < IMG_H // CHUNK)
    ]
    print(f"invalid coordinates: {len(invalid)}")
    for item in invalid[:20]:
        print(f"  {item['source']} {item['name']} ({item['x']}, {item['y']})")

    print("underground point terrain sample, radius=3")
    point_report = []
    low_activity = []
    for point in points:
        if point["floor"] != "underground":
            continue
        active, total = point_activity(
            map_image,
            point["x"],
            point["y"],
            underground_y_mode=args.underground_y_mode,
        )
        nearest_active = nearest_mask_distance(
            active_mask,
            point["x"],
            point["y"],
            underground_y_mode=args.underground_y_mode,
        )
        nearest_changed = (
            nearest_mask_distance(
                changed_mask,
                point["x"],
                point["y"],
                underground_y_mode=args.underground_y_mode,
            )
            if changed_mask is not None
            else None
        )
        changed = None
        if previous is not None:
            changed = changed_activity(
                previous,
                map_image,
                point["x"],
                point["y"],
                underground_y_mode=args.underground_y_mode,
            )[0]
        if nearest_active is None or nearest_active > 24:
            low_activity.append((point, active, total, changed))
        point_report.append(
            {
                **point,
                "active_pixels_radius3": active,
                "nearest_visible_pixel": nearest_active,
                "changed_pixels_radius3": changed,
                "nearest_changed_pixel": nearest_changed,
            }
        )
        suffix = f", changed_pixels={changed}, nearest_changed={nearest_changed}" if changed is not None else ""
        print(
            f"  {point['source']:13s} {point['name'][:42]:42s} active={active:2d}/{total} "
            f"nearest_visible={nearest_active}{suffix}"
        )

    print(f"underground points >24 px from visible terrain: {len(low_activity)}")
    for point, _, _, _ in low_activity[:20]:
        match = next(item for item in point_report if item["name"] == point["name"] and item["source"] == point["source"])
        print(
            f"  far: {point['source']} {point['name']} "
            f"({point['x']:.0f}, {point['y']:.0f}) nearest_visible={match['nearest_visible_pixel']}"
        )

    active_chunks = active_underground_chunks(active_mask, underground_y_mode=args.underground_y_mode)
    zone_cells = {(c["cx"], c["cy"]) for c in zones if c["floor"] == "underground"}
    encounter_cells = {(c["cx"], c["cy"]) for c in encounters if c["floor"] == "underground"}
    chunk_coverage_report = {}
    print("underground chunk coverage")
    for label, cells in (("zones", zones), ("encounters", encounters)):
        coverage = chunk_coverage(active_mask, cells, underground_y_mode=args.underground_y_mode)
        chunk_coverage_report[label] = coverage
        percent = (coverage["with_visible_pixels"] / coverage["total"] * 100) if coverage["total"] else 0
        print(
            f"  {label:13s} chunks={coverage['total']} with_visible={coverage['with_visible_pixels']} "
            f"({percent:.1f}%) visible_pixels={coverage['visible_pixels']}"
        )
    print(f"  active map chunks: {len(active_chunks)}")
    print(f"  active chunks covered by zones: {len(active_chunks & zone_cells)} / {len(active_chunks)}")
    print(f"  active chunks covered by encounters: {len(active_chunks & encounter_cells)} / {len(active_chunks)}")
    uncovered = sorted(active_chunks - zone_cells - encounter_cells)
    print(f"  active chunks not covered by zone/encounter data: {len(uncovered)}")
    if uncovered:
        print("  sample uncovered:", ", ".join(f"{cx},{cy}" for cx, cy in uncovered[:20]))

    chunk_proximity_report = {}
    print("underground chunk proximity to visible map chunks")
    for label, cells in (("zones", zone_cells), ("encounters", encounter_cells)):
        distances = nearest_chunk_distances(cells, active_chunks)
        summary = summarize_distances(distances)
        offset = best_offset_overlap(cells, active_chunks)
        chunk_proximity_report[label] = {"distance": summary, "best_offset": offset}
        if not summary:
            print(f"  {label:13s} no cells or no active chunks")
            continue
        print(
            f"  {label:13s} within_0={summary['within_0_chunks']} within_5={summary['within_5_chunks']} "
            f"within_16={summary['within_16_chunks']} p50={summary['p50_chunks']:.1f} "
            f"p90={summary['p90_chunks']:.1f} max={summary['max_chunks']}"
        )
        percent = (offset["overlap"] / len(cells) * 100) if cells else 0
        print(
            f"  {label:13s} best_offset dx={offset['dx']} dy={offset['dy']} "
            f"overlap={offset['overlap']}/{len(cells)} ({percent:.1f}%)"
        )

    draw_diagnostic(
        map_image,
        points,
        zones,
        encounters,
        args.diagnostic,
        underground_y_mode=args.underground_y_mode,
    )
    print(f"diagnostic: {args.diagnostic}")
    if args.report_json:
        args.report_json.parent.mkdir(parents=True, exist_ok=True)
        args.report_json.write_text(
            json.dumps(
                {
                    "underground_y_mode": args.underground_y_mode,
                    "invalid_coordinates": invalid,
                    "underground_points": point_report,
                    "underground_chunk_coverage": chunk_coverage_report,
                    "underground_chunk_proximity": chunk_proximity_report,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"report_json: {args.report_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
