from __future__ import annotations

import argparse
import base64
import json
import sys
from array import array
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EXTRACTED_DIR = ROOT / ".analysis" / "rogue_data_vpack_2026-09-02"
DEFAULT_OUTPUT = DEFAULT_EXTRACTED_DIR / "Safe_Zones_candidate.png"
LIVE_OUTPUT = (ROOT / "img" / "Safe_Zones.png").resolve()
CHUNK_SIZE = 16
MAP_CHUNK_ROWS = 256
FILL = (0, 205, 255, 48)
HATCH = (235, 250, 255, 128)
BOUNDARY = (255, 255, 255, 220)


def read_safezone_grid(path: Path) -> tuple[int, int, array[int], dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    width = int(payload["width"])
    height = int(payload["height"])
    encoded = payload["grid"]
    if not isinstance(encoded, str):
        raise ValueError("safezones.json grid must be a base64 string")

    raw = base64.b64decode(encoded, validate=True)
    expected_bytes = width * height * 2
    if len(raw) != expected_bytes:
        raise ValueError(f"safe-zone grid is {len(raw)} bytes; expected {expected_bytes}")

    values: array[int] = array("h")
    values.frombytes(raw)
    if sys.byteorder != "little":
        values.byteswap()
    unique_values = set(values)
    if not unique_values.issubset({0, 1}):
        raise ValueError(f"safe-zone grid contains unexpected values: {sorted(unique_values)}")
    if int(payload.get("element_count", len(values))) != len(values):
        raise ValueError("safe-zone element_count does not match the decoded grid")
    return width, height, values, payload


def render_safezone_overlay(width: int, height: int, values: array[int]) -> tuple[Image.Image, int]:
    if width != 512 or height != 512:
        raise ValueError(f"expected a 512x512 safe-zone grid, got {width}x{height}")
    if height < MAP_CHUNK_ROWS:
        raise ValueError(f"safe-zone grid needs at least {MAP_CHUNK_ROWS} map rows")

    outside_count = sum(1 for value in values[width * MAP_CHUNK_ROWS :] if value)
    if outside_count:
        raise ValueError(
            f"safe-zone grid has {outside_count} active cells outside the current combined-map canvas"
        )

    output = Image.new("RGBA", (width * CHUNK_SIZE, MAP_CHUNK_ROWS * CHUNK_SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(output)
    hatch_mask = Image.new("L", (CHUNK_SIZE, CHUNK_SIZE), 0)
    hatch_pixels = hatch_mask.load()
    for y in range(CHUNK_SIZE):
        for x in range(CHUNK_SIZE):
            if (x + y) % CHUNK_SIZE < 2:
                hatch_pixels[x, y] = 255

    safe_cells: list[tuple[int, int]] = []
    for chunk_y in range(MAP_CHUNK_ROWS):
        row_offset = chunk_y * width
        for chunk_x in range(width):
            if values[row_offset + chunk_x] != 1:
                continue
            safe_cells.append((chunk_x, chunk_y))
            x0 = chunk_x * CHUNK_SIZE
            y0 = chunk_y * CHUNK_SIZE
            draw.rectangle((x0, y0, x0 + CHUNK_SIZE - 1, y0 + CHUNK_SIZE - 1), fill=FILL)
            output.paste(HATCH, (x0, y0), hatch_mask)

    def is_safe(chunk_x: int, chunk_y: int) -> bool:
        if chunk_x < 0 or chunk_x >= width or chunk_y < 0 or chunk_y >= MAP_CHUNK_ROWS:
            return False
        return values[chunk_y * width + chunk_x] == 1

    for chunk_x, chunk_y in safe_cells:
        x0 = chunk_x * CHUNK_SIZE
        y0 = chunk_y * CHUNK_SIZE
        x1 = x0 + CHUNK_SIZE - 1
        y1 = y0 + CHUNK_SIZE - 1
        if not is_safe(chunk_x, chunk_y - 1):
            draw.line((x0, y0, x1, y0), fill=BOUNDARY)
        if not is_safe(chunk_x, chunk_y + 1):
            draw.line((x0, y1, x1, y1), fill=BOUNDARY)
        if not is_safe(chunk_x - 1, chunk_y):
            draw.line((x0, y0, x0, y1), fill=BOUNDARY)
        if not is_safe(chunk_x + 1, chunk_y):
            draw.line((x1, y0, x1, y1), fill=BOUNDARY)

    return output, len(safe_cells)


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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate the Safe Zones map overlay from client safezones.json.")
    parser.add_argument("--extracted-dir", type=Path, default=DEFAULT_EXTRACTED_DIR)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--check", action="store_true", help="Verify that --output exactly matches a fresh render.")
    parser.add_argument(
        "--allow-live-output",
        action="store_true",
        help="Allow writing directly to img/Safe_Zones.png after validation.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = args.extracted_dir / "safezones.json"
    if not source.exists():
        raise SystemExit(f"error: missing safe-zone source: {source}")

    output = args.output.resolve()
    if not args.check and output == LIVE_OUTPUT and not args.allow_live_output:
        raise SystemExit("error: refusing to write directly to img/Safe_Zones.png; render to .analysis first")

    try:
        width, height, values, payload = read_safezone_grid(source)
        image, safe_count = render_safezone_overlay(width, height, values)
    except (KeyError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"error: invalid safe-zone source: {error}") from error

    if args.check:
        if not images_match(image, output):
            print(f"SAFE ZONE OVERLAY STALE: {args.output}")
            return 1
        print(f"SAFE ZONE OVERLAY CURRENT: {args.output}")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        image.save(args.output, format="PNG", optimize=True)
        print(f"safe-zone overlay: {args.output}")

    print(f"source: {source}")
    print(f"generated at: {payload.get('generated_at', 'unknown')}")
    print(f"safe chunks: {safe_count}")
    print(f"image size: {image.width}x{image.height}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
