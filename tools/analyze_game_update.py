from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
from collections import Counter, deque
from io import BytesIO
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
GENERATED_FIELD = "generated_at"
RECORD_PAYLOADS = ("armors.json", "monsters.json", "useables.json", "weapons.json")
GRID_PAYLOADS = ("locales.json", "safezones.json", "warfronts.json")
PAYLOAD_NAMES = tuple(
    sorted(
        set(RECORD_PAYLOADS)
        | set(GRID_PAYLOADS)
        | {
            "collectables.json",
            "map.json",
            "npcs.json",
            "objecttypes.json",
            "player_tables.json",
            "tiles.json",
        }
    )
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare two extracted Project Rogue client builds without changing live site data."
    )
    parser.add_argument("--old-dir", type=Path, required=True)
    parser.add_argument("--new-dir", type=Path, required=True)
    parser.add_argument("--old-graphics-dir", type=Path)
    parser.add_argument("--new-graphics-dir", type=Path)
    parser.add_argument("--live-map", type=Path, default=ROOT / "img" / "Map_Combined.png")
    parser.add_argument("--candidate-map", type=Path, required=True)
    parser.add_argument("--monster-levels", type=Path, default=ROOT / "data" / "monster_levels.json")
    parser.add_argument("--encounters", type=Path, default=ROOT / "data" / "encounters.json")
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--label", default="client update")
    return parser.parse_args()


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def without_generated_at(data: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in data.items() if key != GENERATED_FIELD}


def payload_summary(old_dir: Path, new_dir: Path) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name in PAYLOAD_NAMES:
        old_path = old_dir / name
        new_path = new_dir / name
        if not old_path.is_file() or not new_path.is_file():
            result[name] = {"old_exists": old_path.is_file(), "new_exists": new_path.is_file()}
            continue
        old_data = read_json(old_path)
        new_data = read_json(new_path)
        result[name] = {
            "old_bytes": old_path.stat().st_size,
            "new_bytes": new_path.stat().st_size,
            "old_sha256": sha256(old_path),
            "new_sha256": sha256(new_path),
            "semantic_changed": without_generated_at(old_data) != without_generated_at(new_data),
            "old_generated_at": old_data.get(GENERATED_FIELD),
            "new_generated_at": new_data.get(GENERATED_FIELD),
        }
    return result


def decode_map(path: Path) -> tuple[dict[str, Any], np.ndarray, np.ndarray]:
    data = read_json(path)
    chunk_map = np.frombuffer(base64.b64decode(data["chunk_map"]), dtype="<u2").reshape(
        int(data["chunk_map_width"]), int(data["chunk_map_height"])
    )
    chunks = np.frombuffer(base64.b64decode(data["chunks"]), dtype="<u2").reshape(
        int(data["layer_count"]),
        int(data["chunk_count"]),
        int(data["chunk_tile_height"]),
        int(data["chunk_tile_width"]),
    )
    return data, chunk_map, chunks


def decode_grid(path: Path) -> np.ndarray:
    data = read_json(path)
    return np.frombuffer(base64.b64decode(data["grid"]), dtype="<i2").reshape(
        int(data["height"]), int(data["width"])
    )


def dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    expanded = np.zeros_like(mask, dtype=bool)
    height, width = mask.shape
    for dy in range(-radius, radius + 1):
        source_y0 = max(0, -dy)
        source_y1 = min(height, height - dy)
        target_y0 = max(0, dy)
        target_y1 = min(height, height + dy)
        for dx in range(-radius, radius + 1):
            source_x0 = max(0, -dx)
            source_x1 = min(width, width - dx)
            target_x0 = max(0, dx)
            target_x1 = min(width, width + dx)
            expanded[target_y0:target_y1, target_x0:target_x1] |= mask[
                source_y0:source_y1, source_x0:source_x1
            ]
    return expanded


def connected_regions(mask: np.ndarray, *, merge_radius: int = 0) -> list[dict[str, int]]:
    source = mask.astype(bool)
    search = dilate(source, merge_radius) if merge_radius else source
    visited = np.zeros_like(search, dtype=bool)
    height, width = search.shape
    regions: list[dict[str, int]] = []

    for start_y, start_x in zip(*np.nonzero(search)):
        if visited[start_y, start_x]:
            continue
        queue = deque([(int(start_y), int(start_x))])
        visited[start_y, start_x] = True
        component: list[tuple[int, int]] = []
        while queue:
            y, x = queue.popleft()
            component.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < height and 0 <= nx < width and search[ny, nx] and not visited[ny, nx]:
                        visited[ny, nx] = True
                        queue.append((ny, nx))

        ys = [y for y, x in component if source[y, x]]
        xs = [x for y, x in component if source[y, x]]
        if not xs:
            continue
        regions.append(
            {
                "x0": min(xs),
                "y0": min(ys),
                "x1": max(xs),
                "y1": max(ys),
                "changed_cells": len(xs),
            }
        )

    return sorted(regions, key=lambda item: item["changed_cells"], reverse=True)


def map_data_diff(old_path: Path, new_path: Path) -> dict[str, Any]:
    _, old_chunk_map, old_chunks = decode_map(old_path)
    _, new_chunk_map, new_chunks = decode_map(new_path)
    chunk_map_mask = old_chunk_map != new_chunk_map
    chunk_entries = []
    for x, y in zip(*np.nonzero(chunk_map_mask)):
        chunk_entries.append(
            {"x": int(x), "y": int(y), "old": int(old_chunk_map[x, y]), "new": int(new_chunk_map[x, y])}
        )

    chunk_mask = old_chunks != new_chunks
    layer_counts = {
        str(layer): int(chunk_mask[layer].sum()) for layer in range(chunk_mask.shape[0]) if chunk_mask[layer].any()
    }
    affected_chunk_ids = sorted(int(value) for value in np.unique(np.nonzero(chunk_mask)[1]))
    return {
        "chunk_map_changed_entries": len(chunk_entries),
        "chunk_map_changes": chunk_entries,
        "chunk_tile_changed_entries": int(chunk_mask.sum()),
        "chunk_tile_changes_by_layer": layer_counts,
        "affected_chunk_definition_ids": affected_chunk_ids,
    }


def raster_map_diff(old_path: Path, new_path: Path) -> tuple[dict[str, Any], np.ndarray, list[dict[str, Any]]]:
    old = np.asarray(Image.open(old_path).convert("RGB"))
    new = np.asarray(Image.open(new_path).convert("RGB"))
    if old.shape != new.shape:
        raise ValueError(f"map image shapes differ: {old.shape} vs {new.shape}")
    changed = np.any(old != new, axis=2)
    height, width = changed.shape
    if height % 16 or width % 16:
        raise ValueError("map dimensions must be divisible by 16")
    cells = changed.reshape(height // 16, 16, width // 16, 16).any(axis=(1, 3))
    regions = connected_regions(cells, merge_radius=2)
    midpoint = width // 2
    detailed_regions: list[dict[str, Any]] = []
    for index, region in enumerate(regions, start=1):
        px = {
            "x0": region["x0"] * 16,
            "y0": region["y0"] * 16,
            "x1": (region["x1"] + 1) * 16 - 1,
            "y1": (region["y1"] + 1) * 16 - 1,
        }
        region_mask = changed[px["y0"] : px["y1"] + 1, px["x0"] : px["x1"] + 1]
        floor = "overworld" if px["x0"] < midpoint else "underground"
        local_offset = 0 if floor == "overworld" else midpoint
        detailed_regions.append(
            {
                "id": index,
                "floor": floor,
                "chunk_bbox": {
                    "x0": region["x0"] - local_offset // 16,
                    "y0": region["y0"],
                    "x1": region["x1"] - local_offset // 16,
                    "y1": region["y1"],
                },
                "game_tile_bbox": {
                    "x0": px["x0"] - local_offset,
                    "y0": px["y0"],
                    "x1": px["x1"] - local_offset,
                    "y1": px["y1"],
                },
                "combined_image_pixel_bbox": px,
                "changed_chunks": region["changed_cells"],
                "changed_pixels": int(region_mask.sum()),
            }
        )

    result = {
        "image_size": {"width": width, "height": height},
        "changed_pixels": int(changed.sum()),
        "exact_pixel_ratio": float(1.0 - changed.mean()),
        "overworld_changed_pixels": int(changed[:, :midpoint].sum()),
        "underground_changed_pixels": int(changed[:, midpoint:].sum()),
        "changed_chunks": int(cells.sum()),
        "regions": detailed_regions,
    }
    return result, changed, detailed_regions


def grid_diffs(old_dir: Path, new_dir: Path) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for filename in GRID_PAYLOADS:
        old = decode_grid(old_dir / filename)
        new = decode_grid(new_dir / filename)
        mask = old != new
        transitions = Counter((int(before), int(after)) for before, after in zip(old[mask], new[mask]))
        regions = connected_regions(mask, merge_radius=1)
        result[filename] = {
            "changed_cells": int(mask.sum()),
            "transitions": [
                {"old": old_value, "new": new_value, "count": count}
                for (old_value, new_value), count in transitions.most_common()
            ],
            "regions": regions,
        }
    return result


def records_for_payload(filename: str, data: dict[str, Any]) -> dict[tuple[int, ...], dict[str, Any]]:
    if filename in {"armors.json", "weapons.json"}:
        root_key = filename.removesuffix(".json")
        return {
            (int(group["type"]), int(item["id"])): item
            for group in data[root_key]
            for item in group["items"]
        }
    root_key = filename.removesuffix(".json")
    return {(int(item["id"]),): item for item in data[root_key]}


def record_diffs(old_dir: Path, new_dir: Path) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for filename in RECORD_PAYLOADS:
        old_records = records_for_payload(filename, read_json(old_dir / filename))
        new_records = records_for_payload(filename, read_json(new_dir / filename))
        added_keys = sorted(new_records.keys() - old_records.keys())
        removed_keys = sorted(old_records.keys() - new_records.keys())
        all_old_fields = set().union(*(record.keys() for record in old_records.values()))
        all_new_fields = set().union(*(record.keys() for record in new_records.values()))
        added_fields = sorted(all_new_fields - all_old_fields)
        removed_fields = sorted(all_old_fields - all_new_fields)
        changed_field_counts: Counter[str] = Counter()
        changed_records: list[dict[str, Any]] = []
        activated: list[dict[str, Any]] = []
        deactivated: list[dict[str, Any]] = []

        for key in sorted(old_records.keys() & new_records.keys()):
            before = old_records[key]
            after = new_records[key]
            fields: dict[str, Any] = {}
            for field in sorted((set(before) | set(after)) - set(added_fields) - set(removed_fields)):
                if before.get(field) != after.get(field):
                    changed_field_counts[field] += 1
                    fields[field] = {"old": before.get(field), "new": after.get(field)}
            if fields:
                changed_records.append(
                    {
                        "key": list(key),
                        "old_name": before.get("name"),
                        "new_name": after.get("name"),
                        "fields": fields,
                    }
                )
            if before.get("name") == "Unused" and after.get("name") != "Unused":
                activated.append({"key": list(key), "name": after.get("name")})
            if before.get("name") != "Unused" and after.get("name") == "Unused":
                deactivated.append({"key": list(key), "name": before.get("name")})

        added_field_values: dict[str, Any] = {}
        for field in added_fields:
            values = Counter(str(record.get(field)) for record in new_records.values())
            nonzero_named = [
                {"key": list(key), "name": record.get("name"), "value": record.get(field)}
                for key, record in new_records.items()
                if record.get("name") != "Unused" and record.get(field) not in (None, 0, "", False)
            ]
            added_field_values[field] = {
                "distribution": dict(values.most_common()),
                "nonzero_named_records": nonzero_named,
            }

        result[filename] = {
            "old_records": len(old_records),
            "new_records": len(new_records),
            "added_records": [
                {"key": list(key), "name": new_records[key].get("name")} for key in added_keys
            ],
            "removed_records": [
                {"key": list(key), "name": old_records[key].get("name")} for key in removed_keys
            ],
            "added_fields": added_fields,
            "removed_fields": removed_fields,
            "added_field_values": added_field_values,
            "changed_records_count": len(changed_records),
            "changed_field_counts": dict(changed_field_counts.most_common()),
            "activated_records": activated,
            "deactivated_records": deactivated,
            "changed_records": changed_records,
        }
    return result


def monster_site_compatibility(new_dir: Path, levels_path: Path, encounters_path: Path) -> dict[str, Any]:
    monsters = read_json(new_dir / "monsters.json")["monsters"]
    active = {item["name"]: int(item["monster_level"]) for item in monsters if item.get("used") and item.get("name") != "Unused"}
    levels = {name: int(level) for name, level in read_json(levels_path).items()}
    encounter_data = read_json(encounters_path)
    encounter_names = sorted({name for names in encounter_data.values() for name in names})
    return {
        "active_client_monsters": len(active),
        "site_level_entries": len(levels),
        "client_monsters_missing_from_site_levels": sorted(set(active) - set(levels)),
        "site_levels_missing_from_client": sorted(set(levels) - set(active)),
        "level_mismatches": [
            {"name": name, "site": levels[name], "client": active[name]}
            for name in sorted(set(active) & set(levels))
            if levels[name] != active[name]
        ],
        "encounter_monsters_missing_from_client": sorted(set(encounter_names) - set(active)),
        "encounter_monsters_missing_site_levels": sorted(set(encounter_names) - set(levels)),
    }


def add_nearby_manual_markers(regions: list[dict[str, Any]], data_dir: Path) -> None:
    points: list[dict[str, Any]] = []
    for filename, kind in (("towns.json", "town"), ("poi.json", "poi")):
        for item in read_json(data_dir / filename):
            points.append({"name": item["name"], "kind": kind, "x": int(item["x"]), "y": int(item["y"])})
    for filename, kind in (("caves.json", "cave"), ("portals.json", "portal")):
        for item in read_json(data_dir / filename):
            for endpoint in ("entry", "exit"):
                point = item[endpoint]
                points.append(
                    {
                        "name": item["name"],
                        "kind": f"{kind} {endpoint}",
                        "x": int(point["x"]),
                        "y": int(point["y"]),
                    }
                )

    for region in regions:
        box = region["combined_image_pixel_bbox"]
        center_x = (box["x0"] + box["x1"]) / 2
        center_y = (box["y0"] + box["y1"]) / 2
        nearest = sorted(
            points,
            key=lambda point: math.hypot(point["x"] - center_x, point["y"] - center_y),
        )[:5]
        region["nearby_manual_markers"] = [
            {
                **point,
                "distance_tiles": round(math.hypot(point["x"] - center_x, point["y"] - center_y), 1),
            }
            for point in nearest
        ]


def image_from_graphics_json(path: Path) -> Image.Image:
    data = read_json(path)
    raw = data["Data"]
    if raw.startswith("data:image"):
        raw = raw.split(",", 1)[1]
    return Image.open(BytesIO(base64.b64decode(raw))).convert("RGBA")


def graphics_diffs(old_dir: Path | None, new_dir: Path | None) -> dict[str, Any]:
    if old_dir is None or new_dir is None:
        return {}
    result: dict[str, Any] = {}
    names = sorted({path.name for path in old_dir.glob("*.json")} | {path.name for path in new_dir.glob("*.json")})
    for name in names:
        old_path = old_dir / name
        new_path = new_dir / name
        if not old_path.is_file() or not new_path.is_file():
            result[name] = {"old_exists": old_path.is_file(), "new_exists": new_path.is_file()}
            continue
        old = np.asarray(image_from_graphics_json(old_path))
        new = np.asarray(image_from_graphics_json(new_path))
        if old.shape != new.shape:
            result[name] = {"old_shape": list(old.shape), "new_shape": list(new.shape), "shape_changed": True}
            continue
        mask = np.any(old != new, axis=2)
        entry: dict[str, Any] = {
            "shape": list(old.shape),
            "changed_pixels": int(mask.sum()),
            "exact_pixel_ratio": float(1.0 - mask.mean()),
        }
        if mask.any():
            ys, xs = np.nonzero(mask)
            entry["changed_pixel_bbox"] = {
                "x0": int(xs.min()),
                "y0": int(ys.min()),
                "x1": int(xs.max()),
                "y1": int(ys.max()),
            }
        result[name] = entry
    return result


def expanded_bbox(box: dict[str, int], width: int, height: int, padding: int) -> tuple[int, int, int, int]:
    return (
        max(0, box["x0"] - padding),
        max(0, box["y0"] - padding),
        min(width - 1, box["x1"] + padding),
        min(height - 1, box["y1"] + padding),
    )


def draw_region_boxes(image: Image.Image, regions: Iterable[dict[str, Any]]) -> Image.Image:
    result = image.copy()
    draw = ImageDraw.Draw(result)
    for region in regions:
        box = expanded_bbox(region["combined_image_pixel_bbox"], result.width, result.height, 24)
        draw.rectangle(box, outline=(255, 230, 0), width=12)
        tile = region["game_tile_bbox"]
        label = f"{region['id']}: {region['floor']} tile ({tile['x0']},{tile['y0']})"
        text_box = draw.textbbox((0, 0), label)
        label_width = text_box[2] - text_box[0] + 12
        label_height = text_box[3] - text_box[1] + 10
        label_y = max(0, box[1] - label_height)
        draw.rectangle((box[0], label_y, box[0] + label_width, label_y + label_height), fill=(20, 20, 20))
        draw.text((box[0] + 6, label_y + 4), label, fill=(255, 230, 0))
    return result


def save_overview(old_path: Path, new_path: Path, regions: list[dict[str, Any]], output: Path, label: str) -> None:
    old = Image.open(old_path).convert("RGB")
    new = draw_region_boxes(Image.open(new_path).convert("RGB"), regions)
    target_width = 2048
    target_height = round(new.height * target_width / new.width)
    old = old.resize((target_width, target_height), Image.Resampling.NEAREST)
    new = new.resize((target_width, target_height), Image.Resampling.NEAREST)
    header = 34
    canvas = Image.new("RGB", (target_width, (target_height + header) * 2), (22, 22, 22))
    draw = ImageDraw.Draw(canvas)
    draw.text((10, 10), f"NEW - {label} (yellow boxes mark changed regions)", fill=(255, 255, 255))
    canvas.paste(new, (0, header))
    old_y = target_height + header
    draw.text((10, old_y + 10), "OLD - current live map", fill=(255, 255, 255))
    canvas.paste(old, (0, old_y + header))
    canvas.save(output)


def save_closeups(old_path: Path, new_path: Path, regions: list[dict[str, Any]], output: Path) -> None:
    old = Image.open(old_path).convert("RGB")
    new = Image.open(new_path).convert("RGB")
    selected = regions[:12]
    pane_width = 760
    pane_height = 420
    header = 52
    row_height = pane_height + header
    canvas = Image.new("RGB", (pane_width * 2, max(1, len(selected)) * row_height), (22, 22, 22))
    draw = ImageDraw.Draw(canvas)

    for row, region in enumerate(selected):
        box = region["combined_image_pixel_bbox"]
        crop_box = expanded_bbox(box, new.width, new.height, 96)
        x0, y0, x1, y1 = crop_box
        crop_width = x1 - x0 + 1
        crop_height = y1 - y0 + 1
        minimum = 320
        if crop_width < minimum:
            extra = minimum - crop_width
            x0 = max(0, x0 - extra // 2)
            x1 = min(new.width - 1, x1 + extra - extra // 2)
        if crop_height < minimum:
            extra = minimum - crop_height
            y0 = max(0, y0 - extra // 2)
            y1 = min(new.height - 1, y1 + extra - extra // 2)
        pil_box = (x0, y0, x1 + 1, y1 + 1)
        new_crop = new.crop(pil_box)
        old_crop = old.crop(pil_box)
        scale = min(pane_width / new_crop.width, pane_height / new_crop.height)
        size = (max(1, round(new_crop.width * scale)), max(1, round(new_crop.height * scale)))
        new_crop = new_crop.resize(size, Image.Resampling.NEAREST)
        old_crop = old_crop.resize(size, Image.Resampling.NEAREST)
        new_draw = ImageDraw.Draw(new_crop)
        relative = (
            round((box["x0"] - x0 - 16) * scale),
            round((box["y0"] - y0 - 16) * scale),
            round((box["x1"] - x0 + 16) * scale),
            round((box["y1"] - y0 + 16) * scale),
        )
        new_draw.rectangle(relative, outline=(255, 230, 0), width=6)
        top = row * row_height
        tile = region["game_tile_bbox"]
        chunk = region["chunk_bbox"]
        title = (
            f"Region {region['id']} - {region['floor']} game tiles "
            f"({tile['x0']},{tile['y0']}) to ({tile['x1']},{tile['y1']}) - "
            f"chunks ({chunk['x0']},{chunk['y0']}) to ({chunk['x1']},{chunk['y1']}) - "
            f"{region['changed_pixels']} changed tiles"
        )
        draw.text((10, top + 8), title, fill=(255, 255, 255))
        draw.text((10, top + 28), "NEW", fill=(255, 230, 0))
        draw.text((pane_width + 10, top + 28), "OLD", fill=(210, 210, 210))
        new_x = (pane_width - new_crop.width) // 2
        old_x = pane_width + (pane_width - old_crop.width) // 2
        image_y = top + header + (pane_height - new_crop.height) // 2
        canvas.paste(new_crop, (new_x, image_y))
        canvas.paste(old_crop, (old_x, image_y))
    canvas.save(output)


def save_graphics_closeups(
    old_dir: Path,
    new_dir: Path,
    graphics_report: dict[str, Any],
    output: Path,
) -> None:
    changed = [
        (name, entry)
        for name, entry in graphics_report.items()
        if entry.get("changed_pixels", 0) or entry.get("shape_changed")
    ]
    if not changed:
        return
    pane_width = 760
    pane_height = 420
    header = 48
    canvas = Image.new("RGB", (pane_width * 2, len(changed) * (pane_height + header)), (22, 22, 22))
    draw = ImageDraw.Draw(canvas)
    for row, (name, entry) in enumerate(changed):
        old = image_from_graphics_json(old_dir / name)
        new = image_from_graphics_json(new_dir / name)
        raw_box = entry.get("changed_pixel_bbox")
        if raw_box:
            x0, y0, x1, y1 = expanded_bbox(raw_box, new.width, new.height, 32)
            crop_box = (x0, y0, x1 + 1, y1 + 1)
        else:
            crop_box = (0, 0, new.width, new.height)
            x0 = y0 = 0
        old_crop = old.crop(crop_box)
        new_crop = new.crop(crop_box)
        scale = min(pane_width / new_crop.width, pane_height / new_crop.height)
        size = (max(1, round(new_crop.width * scale)), max(1, round(new_crop.height * scale)))
        old_crop = old_crop.resize(size, Image.Resampling.NEAREST)
        new_crop = new_crop.resize(size, Image.Resampling.NEAREST)
        if raw_box:
            scaled_box = (
                round((raw_box["x0"] - x0) * scale),
                round((raw_box["y0"] - y0) * scale),
                round((raw_box["x1"] - x0) * scale),
                round((raw_box["y1"] - y0) * scale),
            )
            ImageDraw.Draw(new_crop).rectangle(scaled_box, outline=(255, 230, 0), width=5)
        top = row * (pane_height + header)
        draw.text((10, top + 8), f"{name} - {entry.get('changed_pixels', 'shape')} changed pixels", fill=(255, 255, 255))
        draw.text((10, top + 27), "NEW", fill=(255, 230, 0))
        draw.text((pane_width + 10, top + 27), "OLD", fill=(210, 210, 210))
        image_y = top + header + (pane_height - new_crop.height) // 2
        canvas.paste(new_crop.convert("RGB"), ((pane_width - new_crop.width) // 2, image_y))
        canvas.paste(
            old_crop.convert("RGB"),
            (pane_width + (pane_width - old_crop.width) // 2, image_y),
        )
    canvas.save(output)


def main() -> int:
    args = parse_args()
    output_dir = args.output_dir or args.new_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    map_result, _, regions = raster_map_diff(args.live_map, args.candidate_map)
    add_nearby_manual_markers(regions, args.data_dir)
    graphics_result = graphics_diffs(args.old_graphics_dir, args.new_graphics_dir)
    report = {
        "label": args.label,
        "old_extracted_dir": str(args.old_dir.resolve()),
        "new_extracted_dir": str(args.new_dir.resolve()),
        "payloads": payload_summary(args.old_dir, args.new_dir),
        "map_data": map_data_diff(args.old_dir / "map.json", args.new_dir / "map.json"),
        "map_render": map_result,
        "grids": grid_diffs(args.old_dir, args.new_dir),
        "records": record_diffs(args.old_dir, args.new_dir),
        "site_monster_compatibility": monster_site_compatibility(
            args.new_dir, args.monster_levels, args.encounters
        ),
        "graphics": graphics_result,
    }
    report_path = output_dir / "game_update_audit.json"
    overview_path = output_dir / "map_update_comparison.png"
    closeups_path = output_dir / "map_update_closeups.png"
    graphics_path = output_dir / "graphics_update_closeups.png"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    save_overview(args.live_map, args.candidate_map, regions, overview_path, args.label)
    save_closeups(args.live_map, args.candidate_map, regions, closeups_path)
    if args.old_graphics_dir is not None and args.new_graphics_dir is not None:
        save_graphics_closeups(args.old_graphics_dir, args.new_graphics_dir, graphics_result, graphics_path)

    changed_payloads = [name for name, item in report["payloads"].items() if item.get("semantic_changed")]
    print(f"report: {report_path}")
    print(f"map comparison: {overview_path}")
    print(f"map closeups: {closeups_path}")
    if graphics_path.is_file():
        print(f"graphics closeups: {graphics_path}")
    print(f"semantic payload changes: {', '.join(changed_payloads) if changed_payloads else 'none'}")
    print(f"map changed pixels: {map_result['changed_pixels']}")
    print(f"map changed regions: {len(regions)}")
    for region in regions:
        print(
            f"  {region['id']}: {region['floor']} game tiles {region['game_tile_bbox']} "
            f"({region['changed_pixels']} changed tiles)"
        )
        nearest = region["nearby_manual_markers"][0]
        print(
            f"     nearest manual marker: {nearest['name']} ({nearest['kind']}, "
            f"{nearest['distance_tiles']} tiles)"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
