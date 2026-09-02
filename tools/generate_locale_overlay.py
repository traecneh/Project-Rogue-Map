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
DEFAULT_IMAGE_OUTPUT = DEFAULT_EXTRACTED_DIR / "Locales_candidate.png"
DEFAULT_DATA_OUTPUT = DEFAULT_EXTRACTED_DIR / "locales_candidate.json"
LIVE_IMAGE_OUTPUT = (ROOT / "img" / "Locales.png").resolve()
LIVE_DATA_OUTPUT = (ROOT / "data" / "locales.json").resolve()
CHUNK_SIZE = 16
MAP_CHUNK_ROWS = 256
FLOOR_CHUNK_WIDTH = 256
PATTERN_COLOR = (248, 250, 252, 76)

STYLE_GROUPS = {
    "@02": {"color": "#787878", "pattern": "diagonal-down"},
    "@03": {"color": "#f03c3c", "pattern": "cross-diagonal"},
    "@04": {"color": "#a050dc", "pattern": "grid"},
    "@06": {"color": "#00be00", "pattern": "dots"},
    "@0A": {"color": "#6464ff", "pattern": "horizontal"},
}

LOCALE_NAMES = {
    1: ("Jail", "@02"),
    2: ("Solitary", "@02"),
    3: ("Silvest", "@06"),
    4: ("Jeel", "@06"),
    5: ("Hothbra", "@06"),
    6: ("Varg", "@06"),
    7: ("Lotor's Castle", "@06"),
    8: ("Vrethpool", "@06"),
    9: ("New Korelth", "@06"),
    10: ("Lopal", "@02"),
    11: ("Garnea", "@06"),
    12: ("Ayaress", "@06"),
    13: ("Ayle", "@06"),
    14: ("Tuhsenn", "@06"),
    15: ("Dexmore", "@0A"),
    16: ("Osgarl", "@0A"),
    17: ("Rogue", "@02"),
    18: ("Viineri", "@06"),
    19: ("Kurass", "@06"),
    20: ("Parian", "@06"),
    21: ("Lyrina", "@06"),
    22: ("Ethera", "@06"),
    23: ("Roctra", "@06"),
    24: ("Bloodwater", "@06"),
    25: ("Farmtown", "@06"),
    26: ("Emperium Abbey", "@0A"),
    27: ("Chlera", "@06"),
    28: ("D'Golar", "@06"),
    29: ("T'Telbek", "@06"),
    30: ("Grognarl", "@06"),
    31: ("Zolkranion Village", "@06"),
    32: ("Zonorian", "@06"),
    33: ("Solodon", "@02"),
    34: ("Desprail", "@02"),
    35: ("Grell", "@02"),
    36: ("Darushk", "@02"),
    37: ("Martarus", "@02"),
    38: ("Arena", "@03"),
    39: ("Battleground", "@02"),
    40: ("Hell", "@03"),
    41: ("Anubis Lair", "@04"),
    42: ("Isle Of Dread", "@03"),
    43: ("Hellfire Peninsula", "@03"),
    44: ("Hell Portal", "@03"),
    45: ("Crypt of Ryonkah", "@03"),
    46: ("Banished Knight Castle", "@04"),
    47: ("Storm Giant Lair", "@03"),
    48: ("Josody", "@06"),
    49: ("Toxicum", "@03"),
    50: ("Druid Stronghold", "@03"),
    51: ("Badlands Cavern", "@03"),
    52: ("Kelvor's Tower", "@03"),
    53: ("Winterland", "@0A"),
    54: ("Badlands Cave", "@03"),
    55: ("Badlands", "@03"),
    56: ("Crestshore", "@06"),
    57: ("Shadowhaven", "@02"),
    58: ("The Necropolis", "@03"),
    59: ("Water Castle", "@04"),
    60: ("Abyss Keep", "@04"),
    61: ("Vel Dran", "@03"),
    62: ("Thornvale", "@06"),
    63: ("Frostgrave Ruins", "@0A"),
    64: ("Hollowpost", "@06"),
    65: ("Frostwatch", "@02"),
    66: ("Obsidian Enclave", "@06"),
    67: ("Warrens Deep", "@02"),
}

ALIASES = {
    17: ["Rogue Town"],
    31: ["Zolkarion Village"],
    39: ["Battlegrounds"],
    42: ["Island of Dread", "IoD"],
    46: ["Banished Knight Fortress"],
    47: ["SGL"],
    58: ["Necropolis"],
    63: ["Frostgrave"],
}


def classify_locale(locale_id: int, style_code: str) -> dict[str, str | None]:
    if style_code == "@06" or locale_id in {15, 16}:
        return {"kind": "town", "alignment": "lawful", "category_label": "Lawful Town"}
    if style_code == "@02":
        if locale_id in {1, 2, 39}:
            return {"kind": "special", "alignment": "criminal", "category_label": "Criminal Locale"}
        return {"kind": "town", "alignment": "criminal", "category_label": "Criminal Town"}
    if style_code == "@04":
        return {"kind": "stronghold", "alignment": None, "category_label": "Stronghold"}
    if locale_id in {53, 63}:
        return {"kind": "region", "alignment": None, "category_label": "Region"}
    if locale_id == 26:
        return {"kind": "poi", "alignment": None, "category_label": "Point of Interest"}
    return {"kind": "dangerous", "alignment": None, "category_label": "Dangerous Locale"}


LOCALES = {
    locale_id: {
        "name": name,
        "client_style_code": style_code,
        **STYLE_GROUPS[style_code],
        **classify_locale(locale_id, style_code),
        "aliases": ALIASES.get(locale_id, []),
    }
    for locale_id, (name, style_code) in LOCALE_NAMES.items()
}


def read_locale_grid(path: Path) -> tuple[int, int, array[int], dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    width = int(payload["width"])
    height = int(payload["height"])
    encoded = payload["grid"]
    if not isinstance(encoded, str):
        raise ValueError("locales.json grid must be a base64 string")

    raw = base64.b64decode(encoded, validate=True)
    expected_bytes = width * height * 2
    if len(raw) != expected_bytes:
        raise ValueError(f"locale grid is {len(raw)} bytes; expected {expected_bytes}")

    values: array[int] = array("h")
    values.frombytes(raw)
    if sys.byteorder != "little":
        values.byteswap()
    if int(payload.get("element_count", len(values))) != len(values):
        raise ValueError("locale element_count does not match the decoded grid")

    unexpected = sorted(set(values) - {0, *LOCALES})
    if unexpected:
        raise ValueError(f"locale grid contains unexpected IDs: {unexpected}")
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
            elif name == "cross-diagonal":
                on = (x - y) % 14 == 0 or (x + y) % 14 == 0
            elif name == "grid":
                on = x % 8 == 0 or y % 8 == 0
            elif name == "dots":
                on = x % 6 < 2 and y % 6 < 2
            elif name == "horizontal":
                on = y % 7 < 2
            else:
                raise ValueError(f"unknown locale pattern: {name}")
            if on:
                pixels[x, y] = 255
    return mask


def render_locale_overlay(width: int, height: int, values: array[int]) -> tuple[Image.Image, dict[int, int]]:
    if width != FLOOR_CHUNK_WIDTH * 2 or height != 512:
        raise ValueError(f"expected a 512x512 locale grid, got {width}x{height}")

    outside_count = sum(1 for value in values[width * MAP_CHUNK_ROWS :] if value)
    if outside_count:
        raise ValueError(f"locale grid has {outside_count} active cells outside the current combined-map canvas")

    output = Image.new("RGBA", (width * CHUNK_SIZE, MAP_CHUNK_ROWS * CHUNK_SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(output)
    masks = {style["pattern"]: pattern_mask(style["pattern"]) for style in STYLE_GROUPS.values()}
    counts = {locale_id: 0 for locale_id in LOCALES}
    active_cells: list[tuple[int, int, int]] = []

    for chunk_y in range(MAP_CHUNK_ROWS):
        row_offset = chunk_y * width
        for chunk_x in range(width):
            locale_id = values[row_offset + chunk_x]
            if not locale_id:
                continue
            counts[locale_id] += 1
            active_cells.append((chunk_x, chunk_y, locale_id))
            definition = LOCALES[locale_id]
            x0 = chunk_x * CHUNK_SIZE
            y0 = chunk_y * CHUNK_SIZE
            draw.rectangle(
                (x0, y0, x0 + CHUNK_SIZE - 1, y0 + CHUNK_SIZE - 1),
                fill=rgba(definition["color"], 38),
            )
            output.paste(PATTERN_COLOR, (x0, y0), masks[definition["pattern"]])

    def id_at(chunk_x: int, chunk_y: int) -> int:
        if chunk_x < 0 or chunk_x >= width or chunk_y < 0 or chunk_y >= MAP_CHUNK_ROWS:
            return 0
        return values[chunk_y * width + chunk_x]

    for chunk_x, chunk_y, locale_id in active_cells:
        x0 = chunk_x * CHUNK_SIZE
        y0 = chunk_y * CHUNK_SIZE
        x1 = x0 + CHUNK_SIZE - 1
        y1 = y0 + CHUNK_SIZE - 1
        boundary = rgba(LOCALES[locale_id]["color"], 215)
        if id_at(chunk_x, chunk_y - 1) != locale_id:
            draw.line((x0, y0, x1, y0), fill=boundary)
        if id_at(chunk_x, chunk_y + 1) != locale_id:
            draw.line((x0, y1, x1, y1), fill=boundary)
        if id_at(chunk_x - 1, chunk_y) != locale_id:
            draw.line((x0, y0, x0, y1), fill=boundary)
        if id_at(chunk_x + 1, chunk_y) != locale_id:
            draw.line((x1, y0, x1, y1), fill=boundary)

    return output, counts


def connected_components(
    values: array[int],
    width: int,
    locale_id: int,
    x_start: int,
    x_end: int,
) -> list[set[tuple[int, int]]]:
    remaining = {
        (x, y)
        for y in range(MAP_CHUNK_ROWS)
        for x in range(x_start, x_end)
        if values[y * width + x] == locale_id
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


def component_bounds(component: set[tuple[int, int]]) -> list[int]:
    xs = [point[0] for point in component]
    ys = [point[1] for point in component]
    return [
        min(xs) * CHUNK_SIZE,
        min(ys) * CHUNK_SIZE,
        (max(xs) + 1) * CHUNK_SIZE,
        (max(ys) + 1) * CHUNK_SIZE,
    ]


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

    for locale_id, definition in LOCALES.items():
        floors: dict[str, int] = {}
        for floor, (x_start, x_end) in floor_ranges.items():
            components = connected_components(values, width, locale_id, x_start, x_end)
            floors[floor] = sum(len(component) for component in components)
            for index, component in enumerate(components):
                x, y = label_cell(component)
                labels.append(
                    {
                        "id": locale_id,
                        "name": definition["name"],
                        "floor": floor,
                        "x": x * CHUNK_SIZE + CHUNK_SIZE // 2,
                        "y": y * CHUNK_SIZE + CHUNK_SIZE // 2,
                        "bounds": component_bounds(component),
                        "component_chunks": len(component),
                        "primary": index == 0,
                    }
                )
        items.append({"id": locale_id, **definition, "chunks": counts[locale_id], "floors": floors})

    return {
        "schema_version": 1,
        "generated_at": payload.get("generated_at"),
        "source": "locales.json",
        "source_encoding": payload.get("encoding"),
        "classification_basis": "Client style codes plus user-confirmed lawful/criminal town classifications",
        "chunk_size": CHUNK_SIZE,
        "map_width": width * CHUNK_SIZE,
        "map_height": MAP_CHUNK_ROWS * CHUNK_SIZE,
        "source_grid_height": height,
        "locales": items,
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
    parser = argparse.ArgumentParser(description="Generate the Locales overlay and labels from client locales.json.")
    parser.add_argument("--extracted-dir", type=Path, default=DEFAULT_EXTRACTED_DIR)
    parser.add_argument("--output-image", type=Path, default=DEFAULT_IMAGE_OUTPUT)
    parser.add_argument("--output-data", type=Path, default=DEFAULT_DATA_OUTPUT)
    parser.add_argument("--check", action="store_true", help="Verify that both outputs match a fresh render.")
    parser.add_argument(
        "--allow-live-output",
        action="store_true",
        help="Allow writing directly to img/Locales.png and data/locales.json after validation.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = args.extracted_dir / "locales.json"
    if not source.exists():
        raise SystemExit(f"error: missing locale source: {source}")

    output_image = args.output_image.resolve()
    output_data = args.output_data.resolve()
    live_output_requested = output_image == LIVE_IMAGE_OUTPUT or output_data == LIVE_DATA_OUTPUT
    if not args.check and live_output_requested and not args.allow_live_output:
        raise SystemExit(
            "error: refusing to write live Locale outputs; render to .analysis first or pass --allow-live-output"
        )

    try:
        width, height, values, payload = read_locale_grid(source)
        image, counts = render_locale_overlay(width, height, values)
        metadata = build_metadata(width, height, values, payload, counts)
    except (KeyError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"error: invalid locale source: {error}") from error

    if args.check:
        image_current = images_match(image, output_image)
        data_current = metadata_matches(metadata, output_data)
        print(f"LOCALE IMAGE {'CURRENT' if image_current else 'STALE'}: {args.output_image}")
        print(f"LOCALE DATA {'CURRENT' if data_current else 'STALE'}: {args.output_data}")
        if not image_current or not data_current:
            return 1
    else:
        args.output_image.parent.mkdir(parents=True, exist_ok=True)
        args.output_data.parent.mkdir(parents=True, exist_ok=True)
        image.save(args.output_image, format="PNG", optimize=True)
        args.output_data.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        print(f"locale overlay: {args.output_image}")
        print(f"locale metadata: {args.output_data}")

    active_ids = sum(1 for count in counts.values() if count)
    print(f"source: {source}")
    print(f"generated at: {payload.get('generated_at', 'unknown')}")
    print(f"locale chunks: {sum(counts.values())}")
    print(f"locale IDs: {active_ids} active, {len(LOCALES) - active_ids} dormant")
    print(f"image size: {image.width}x{image.height}")
    print(f"labels: {len(metadata['labels'])} ({sum(1 for label in metadata['labels'] if label['primary'])} primary)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
