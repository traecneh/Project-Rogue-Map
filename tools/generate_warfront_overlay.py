from __future__ import annotations

import argparse
import base64
import json
import sys
from array import array
from collections import deque
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EXTRACTED_DIR = ROOT / ".analysis" / "rogue_data_vpack_2026-09-02"
DEFAULT_IMAGE_OUTPUT = DEFAULT_EXTRACTED_DIR / "Warfronts_candidate.png"
DEFAULT_DATA_OUTPUT = DEFAULT_EXTRACTED_DIR / "warfronts_candidate.json"
LIVE_IMAGE_OUTPUT = (ROOT / "img" / "Warfronts.png").resolve()
LIVE_DATA_OUTPUT = (ROOT / "data" / "warfronts.json").resolve()
CHUNK_SIZE = 16
MAP_CHUNK_ROWS = 256
FLOOR_CHUNK_WIDTH = 256
BOUNDARY = (255, 255, 255, 220)
PATTERN = (245, 248, 252, 145)

WARFRONTS = {
    1: {"name": "Talazarian Warfront", "label": "Talazarian", "color": "#a855f7", "pattern": "diagonal-down"},
    2: {"name": "Badlands Warfront", "label": "Badlands", "color": "#56b4e9", "pattern": "diagonal-up"},
    3: {"name": "Banished Warfront", "label": "Banished", "color": "#009e73", "pattern": "horizontal"},
    4: {"name": "Necropolitan Warfront", "label": "Necropolitan", "color": "#e69f00", "pattern": "vertical"},
    5: {"name": "Abyssal Warfront", "label": "Abyssal", "color": "#f0e442", "pattern": "cross-diagonal"},
    6: {"name": "Frozen Warfront", "label": "Frozen", "color": "#0072b2", "pattern": "dots"},
    7: {"name": "Toxic Warfront", "label": "Toxic", "color": "#d55e00", "pattern": "grid"},
}


def read_warfront_grid(path: Path) -> tuple[int, int, array[int], dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    width = int(payload["width"])
    height = int(payload["height"])
    encoded = payload["grid"]
    if not isinstance(encoded, str):
        raise ValueError("warfronts.json grid must be a base64 string")

    raw = base64.b64decode(encoded, validate=True)
    expected_bytes = width * height * 2
    if len(raw) != expected_bytes:
        raise ValueError(f"warfront grid is {len(raw)} bytes; expected {expected_bytes}")

    values: array[int] = array("h")
    values.frombytes(raw)
    if sys.byteorder != "little":
        values.byteswap()
    if int(payload.get("element_count", len(values))) != len(values):
        raise ValueError("warfront element_count does not match the decoded grid")

    unexpected = sorted(set(values) - {0, *WARFRONTS})
    if unexpected:
        raise ValueError(f"warfront grid contains unexpected IDs: {unexpected}")
    return width, height, values, payload


def rgba(hex_color: str, alpha: int) -> tuple[int, int, int, int]:
    value = hex_color.removeprefix("#")
    if len(value) != 6:
        raise ValueError(f"invalid RGB color: {hex_color}")
    return tuple(int(value[index : index + 2], 16) for index in (0, 2, 4)) + (alpha,)


def pattern_mask(name: str) -> Image.Image:
    mask = Image.new("L", (CHUNK_SIZE, CHUNK_SIZE), 0)
    pixels = mask.load()
    for y in range(CHUNK_SIZE):
        for x in range(CHUNK_SIZE):
            on = False
            if name == "diagonal-down":
                on = (x - y) % 12 < 2
            elif name == "diagonal-up":
                on = (x + y) % 12 < 2
            elif name == "horizontal":
                on = y % 7 < 2
            elif name == "vertical":
                on = x % 7 < 2
            elif name == "cross-diagonal":
                on = (x - y) % 14 == 0 or (x + y) % 14 == 0
            elif name == "dots":
                on = x % 6 < 2 and y % 6 < 2
            elif name == "grid":
                on = x % 8 == 0 or y % 8 == 0
            else:
                raise ValueError(f"unknown warfront pattern: {name}")
            if on:
                pixels[x, y] = 255
    return mask


def render_warfront_overlay(width: int, height: int, values: array[int]) -> tuple[Image.Image, dict[int, int]]:
    if width != FLOOR_CHUNK_WIDTH * 2 or height != 512:
        raise ValueError(f"expected a 512x512 warfront grid, got {width}x{height}")

    outside_count = sum(1 for value in values[width * MAP_CHUNK_ROWS :] if value)
    if outside_count:
        raise ValueError(
            f"warfront grid has {outside_count} active cells outside the current combined-map canvas"
        )

    output = Image.new("RGBA", (width * CHUNK_SIZE, MAP_CHUNK_ROWS * CHUNK_SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(output)
    masks = {item["pattern"]: pattern_mask(item["pattern"]) for item in WARFRONTS.values()}
    counts = {warfront_id: 0 for warfront_id in WARFRONTS}
    active_cells: list[tuple[int, int, int]] = []

    for chunk_y in range(MAP_CHUNK_ROWS):
        row_offset = chunk_y * width
        for chunk_x in range(width):
            warfront_id = values[row_offset + chunk_x]
            if not warfront_id:
                continue
            counts[warfront_id] += 1
            active_cells.append((chunk_x, chunk_y, warfront_id))
            item = WARFRONTS[warfront_id]
            x0 = chunk_x * CHUNK_SIZE
            y0 = chunk_y * CHUNK_SIZE
            draw.rectangle(
                (x0, y0, x0 + CHUNK_SIZE - 1, y0 + CHUNK_SIZE - 1),
                fill=rgba(item["color"], 56),
            )
            output.paste(PATTERN, (x0, y0), masks[item["pattern"]])

    def id_at(chunk_x: int, chunk_y: int) -> int:
        if chunk_x < 0 or chunk_x >= width or chunk_y < 0 or chunk_y >= MAP_CHUNK_ROWS:
            return 0
        return values[chunk_y * width + chunk_x]

    for chunk_x, chunk_y, warfront_id in active_cells:
        x0 = chunk_x * CHUNK_SIZE
        y0 = chunk_y * CHUNK_SIZE
        x1 = x0 + CHUNK_SIZE - 1
        y1 = y0 + CHUNK_SIZE - 1
        if id_at(chunk_x, chunk_y - 1) != warfront_id:
            draw.line((x0, y0, x1, y0), fill=BOUNDARY)
        if id_at(chunk_x, chunk_y + 1) != warfront_id:
            draw.line((x0, y1, x1, y1), fill=BOUNDARY)
        if id_at(chunk_x - 1, chunk_y) != warfront_id:
            draw.line((x0, y0, x0, y1), fill=BOUNDARY)
        if id_at(chunk_x + 1, chunk_y) != warfront_id:
            draw.line((x1, y0, x1, y1), fill=BOUNDARY)

    return output, counts


def connected_components(
    values: array[int],
    width: int,
    warfront_id: int,
    x_start: int,
    x_end: int,
) -> list[set[tuple[int, int]]]:
    remaining = {
        (x, y)
        for y in range(MAP_CHUNK_ROWS)
        for x in range(x_start, x_end)
        if values[y * width + x] == warfront_id
    }
    components: list[set[tuple[int, int]]] = []
    while remaining:
        seed = min(remaining, key=lambda point: (point[1], point[0]))
        component = {seed}
        remaining.remove(seed)
        queue = deque([seed])
        while queue:
            x, y = queue.popleft()
            for neighbor in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if neighbor not in remaining:
                    continue
                remaining.remove(neighbor)
                component.add(neighbor)
                queue.append(neighbor)
        components.append(component)
    return sorted(components, key=lambda component: (-len(component), min(component)))


def label_cell(component: set[tuple[int, int]]) -> tuple[int, int]:
    centroid_x = sum(x for x, _ in component) / len(component)
    centroid_y = sum(y for _, y in component) / len(component)
    boundary = [
        point
        for point in component
        if any(
            neighbor not in component
            for neighbor in (
                (point[0] - 1, point[1]),
                (point[0] + 1, point[1]),
                (point[0], point[1] - 1),
                (point[0], point[1] + 1),
            )
        )
    ]
    distances = {point: 0 for point in boundary}
    queue = deque(boundary)
    while queue:
        x, y = queue.popleft()
        for neighbor in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if neighbor not in component or neighbor in distances:
                continue
            distances[neighbor] = distances[(x, y)] + 1
            queue.append(neighbor)

    max_distance = max(distances.values(), default=0)
    candidates = [point for point, distance in distances.items() if distance == max_distance]
    return min(
        candidates or component,
        key=lambda point: ((point[0] - centroid_x) ** 2 + (point[1] - centroid_y) ** 2, point[1], point[0]),
    )


def build_metadata(
    width: int,
    height: int,
    values: array[int],
    payload: dict[str, Any],
    counts: dict[int, int],
) -> dict[str, Any]:
    items = []
    labels = []
    floor_ranges = {
        "overworld": (0, FLOOR_CHUNK_WIDTH),
        "underground": (FLOOR_CHUNK_WIDTH, FLOOR_CHUNK_WIDTH * 2),
    }

    for warfront_id, definition in WARFRONTS.items():
        floors: dict[str, int] = {}
        for floor, (x_start, x_end) in floor_ranges.items():
            components = connected_components(values, width, warfront_id, x_start, x_end)
            floors[floor] = sum(len(component) for component in components)
            for index, component in enumerate(components):
                x, y = label_cell(component)
                labels.append(
                    {
                        "id": warfront_id,
                        "name": definition["label"],
                        "floor": floor,
                        "x": x * CHUNK_SIZE + CHUNK_SIZE // 2,
                        "y": y * CHUNK_SIZE + CHUNK_SIZE // 2,
                        "component_chunks": len(component),
                        "primary": index == 0,
                    }
                )
        items.append(
            {
                "id": warfront_id,
                **definition,
                "chunks": counts[warfront_id],
                "floors": floors,
            }
        )

    return {
        "schema_version": 1,
        "generated_at": payload.get("generated_at"),
        "source": "warfronts.json",
        "source_encoding": payload.get("encoding"),
        "chunk_size": CHUNK_SIZE,
        "map_width": width * CHUNK_SIZE,
        "map_height": MAP_CHUNK_ROWS * CHUNK_SIZE,
        "source_grid_height": height,
        "warfronts": items,
        "labels": labels,
    }


def images_match(expected: Image.Image, actual_path: Path) -> bool:
    if not actual_path.exists():
        return False
    with Image.open(actual_path) as actual_source:
        actual = actual_source.convert("RGBA")
        if actual.size != expected.size:
            return False
        for top in range(0, expected.height, 256):
            box = (0, top, expected.width, min(top + 256, expected.height))
            if expected.crop(box).tobytes() != actual.crop(box).tobytes():
                return False
    return True


def metadata_matches(expected: dict[str, Any], actual_path: Path) -> bool:
    if not actual_path.exists():
        return False
    try:
        return json.loads(actual_path.read_text(encoding="utf-8")) == expected
    except (OSError, json.JSONDecodeError):
        return False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate the Warfront Areas overlay and labels from client warfronts.json."
    )
    parser.add_argument("--extracted-dir", type=Path, default=DEFAULT_EXTRACTED_DIR)
    parser.add_argument("--output-image", type=Path, default=DEFAULT_IMAGE_OUTPUT)
    parser.add_argument("--output-data", type=Path, default=DEFAULT_DATA_OUTPUT)
    parser.add_argument("--check", action="store_true", help="Verify that both outputs match a fresh render.")
    parser.add_argument(
        "--allow-live-output",
        action="store_true",
        help="Allow writing directly to img/Warfronts.png and data/warfronts.json after validation.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = args.extracted_dir / "warfronts.json"
    if not source.exists():
        raise SystemExit(f"error: missing warfront source: {source}")

    output_image = args.output_image.resolve()
    output_data = args.output_data.resolve()
    live_output_requested = output_image == LIVE_IMAGE_OUTPUT or output_data == LIVE_DATA_OUTPUT
    if not args.check and live_output_requested and not args.allow_live_output:
        raise SystemExit(
            "error: refusing to write live Warfront outputs; render to .analysis first or pass --allow-live-output"
        )

    try:
        width, height, values, payload = read_warfront_grid(source)
        image, counts = render_warfront_overlay(width, height, values)
        metadata = build_metadata(width, height, values, payload, counts)
    except (KeyError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"error: invalid warfront source: {error}") from error

    if args.check:
        image_current = images_match(image, output_image)
        data_current = metadata_matches(metadata, output_data)
        print(f"WARFRONT IMAGE {'CURRENT' if image_current else 'STALE'}: {args.output_image}")
        print(f"WARFRONT DATA {'CURRENT' if data_current else 'STALE'}: {args.output_data}")
        if not image_current or not data_current:
            return 1
    else:
        args.output_image.parent.mkdir(parents=True, exist_ok=True)
        args.output_data.parent.mkdir(parents=True, exist_ok=True)
        image.save(args.output_image, format="PNG", optimize=True)
        args.output_data.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        print(f"warfront overlay: {args.output_image}")
        print(f"warfront metadata: {args.output_data}")

    print(f"source: {source}")
    print(f"generated at: {payload.get('generated_at', 'unknown')}")
    print(f"warfront chunks: {sum(counts.values())}")
    for warfront_id, item in WARFRONTS.items():
        print(f"  {item['name']}: {counts[warfront_id]}")
    print(f"image size: {image.width}x{image.height}")
    print(f"labels: {len(metadata['labels'])} ({sum(1 for label in metadata['labels'] if label['primary'])} primary)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
