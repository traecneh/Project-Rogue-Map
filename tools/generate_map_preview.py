from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageChops


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "img" / "Map_Combined.png"
DEFAULT_OUTPUT = ROOT / "img" / "Map_Combined-preview.webp"
PREVIEW_SCALE = 0.5


def build_preview(source: Image.Image) -> Image.Image:
    width, height = source.size
    preview_size = (
        max(1, round(width * PREVIEW_SCALE)),
        max(1, round(height * PREVIEW_SCALE)),
    )
    return source.convert("RGB").resize(preview_size, Image.Resampling.NEAREST)


def generate_preview(source_path: Path, output_path: Path) -> tuple[int, int]:
    with Image.open(source_path) as source:
        preview = build_preview(source)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    preview.save(output_path, "WEBP", lossless=True, method=6)
    return preview.size


def preview_is_current(source_path: Path, output_path: Path) -> bool:
    if not output_path.is_file():
        return False
    with Image.open(source_path) as source:
        expected = build_preview(source)
    with Image.open(output_path) as current:
        actual = current.convert("RGB")
    return actual.size == expected.size and ImageChops.difference(actual, expected).getbbox() is None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate the lightweight map preview used by external map thumbnails."
    )
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail when the output is missing or does not match the current source map.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.check:
        if preview_is_current(args.source, args.output):
            print(f"MAP PREVIEW OK: {args.output}")
            return 0
        print(f"MAP PREVIEW STALE: regenerate {args.output} from {args.source}")
        return 1

    width, height = generate_preview(args.source, args.output)
    print(f"MAP PREVIEW GENERATED: {args.output} ({width}x{height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
