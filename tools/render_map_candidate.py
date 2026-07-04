from __future__ import annotations

import argparse
import base64
import json
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


DEFAULT_EXTRACTED_DIR = Path(".analysis") / "rogue_data_vpack_2026-07-03"
DEFAULT_OUTPUT_NAME = "Map_Combined_candidate_source_layout_q00_q10_client.png"
DEFAULT_THUMBNAIL_NAME = "map_candidate_thumbnail.png"
DEFAULT_HYBRID_OUTPUT_NAME = "Map_Combined_hybrid_current_overworld_vpack_underground.png"
DEFAULT_GF_TILES_JSON = Path(r"C:\Users\traec\Desktop\Project Rogue\Client\gf_json\tiles.json")
LIVE_MAP_PATH = Path("img") / "Map_Combined.png"
MIN_UNDERGROUND_ACTIVE_PIXELS = 1000
UNDERGROUND_TRANSFORMS = (
    "identity",
    "rot90_cw",
    "rot90_ccw",
    "rot180",
    "flip_x",
    "flip_y",
    "transpose",
    "anti_transpose",
)


def read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_tile_rgb_palette(path: Path) -> np.ndarray:
    data = read_json(path)
    colors = np.zeros((4096, 3), dtype=np.uint8)
    for tile in data["tiles"]:
        tile_id = int(tile["id"])
        color = tile["color"]
        colors[tile_id] = [int(color["r"]), int(color["g"]), int(color["b"])]
    return colors


def load_atlas_average_palette(gf_tiles_json: Path, fallback: np.ndarray) -> np.ndarray:
    data = read_json(gf_tiles_json)
    raw = data["Data"].strip()
    if raw.startswith("data:image"):
        _, raw = raw.split(",", 1)
    atlas = np.asarray(Image.open(BytesIO(base64.b64decode(raw))).convert("RGBA"))
    tiles_wide = atlas.shape[1] // 16
    tiles_high = atlas.shape[0] // 16
    palette_size = max(fallback.shape[0], tiles_wide * tiles_high)
    palette = np.zeros((palette_size, 3), dtype=np.uint8)
    palette[: fallback.shape[0]] = fallback

    for tile_id in range(tiles_wide * tiles_high):
        x = (tile_id % tiles_wide) * 16
        y = (tile_id // tiles_wide) * 16
        tile = atlas[y : y + 16, x : x + 16]
        opaque = tile[:, :, 3] != 0
        not_magenta = ~((tile[:, :, 0] == 255) & (tile[:, :, 1] == 0) & (tile[:, :, 2] == 255))
        mask = opaque & not_magenta
        if mask.any():
            palette[tile_id] = tile[:, :, :3][mask].mean(axis=0).astype(np.uint8)
    return palette


def load_map_arrays(path: Path) -> tuple[dict, np.ndarray, np.ndarray]:
    data = read_json(path)
    chunk_map = np.frombuffer(base64.b64decode(data["chunk_map"]), dtype="<u2").reshape(
        int(data["chunk_map_width"]),
        int(data["chunk_map_height"]),
    )
    chunks = np.frombuffer(base64.b64decode(data["chunks"]), dtype="<u2").reshape(
        int(data["layer_count"]),
        int(data["chunk_count"]),
        int(data["chunk_tile_height"]),
        int(data["chunk_tile_width"]),
    )
    return data, chunk_map, chunks


def compose_layer_ids(chunks: np.ndarray, ids: np.ndarray, rule: str, layer: int) -> np.ndarray:
    if rule == "single":
        return chunks[layer, ids, :, :]
    if rule == "client-blueprint":
        base = chunks[0, ids, :, :]
        overlay = chunks[1, ids, :, :]
        return np.where(overlay != 0, overlay, base)
    raise ValueError(f"unknown layer rule: {rule}")


def render_page(
    chunk_map: np.ndarray,
    chunks: np.ndarray,
    *,
    qx: int,
    qy: int,
    layer: int,
    layer_rule: str,
) -> np.ndarray:
    # Source order matches the client: ChunkMap[x][y] and Chunks[layer][chunk][x][y].
    ids = chunk_map[qx * 256 : (qx + 1) * 256, qy * 256 : (qy + 1) * 256]
    tile_ids = compose_layer_ids(chunks, ids, layer_rule, layer)
    return tile_ids.transpose(1, 3, 0, 2).reshape(4096, 4096)


def transform_image(image: np.ndarray, transform: str) -> np.ndarray:
    if transform == "identity":
        return image
    if transform == "rot90_cw":
        return np.rot90(image, k=3)
    if transform == "rot90_ccw":
        return np.rot90(image, k=1)
    if transform == "rot180":
        return np.rot90(image, k=2)
    if transform == "flip_x":
        return np.fliplr(image)
    if transform == "flip_y":
        return np.flipud(image)
    if transform == "transpose":
        return np.transpose(image, (1, 0, 2))
    if transform == "anti_transpose":
        return np.flipud(np.fliplr(np.transpose(image, (1, 0, 2))))
    raise ValueError(f"unknown transform: {transform}")


def output_with_transform_suffix(path: Path, transform: str) -> Path:
    if transform == "identity":
        return path
    return path.with_name(f"{path.stem}_{transform}{path.suffix}")


def make_thumbnail(images: list[tuple[str, np.ndarray]], path: Path) -> None:
    width = 512
    thumbs: list[tuple[str, Image.Image]] = []
    for label, arr in images:
        image = Image.fromarray(arr, "RGB")
        height = max(1, round(image.height * (width / image.width)))
        thumbs.append((label, image.resize((width, height), Image.Resampling.NEAREST)))

    label_height = 24
    canvas = Image.new("RGB", (width * len(thumbs), thumbs[0][1].height + label_height), (24, 24, 24))
    draw = ImageDraw.Draw(canvas)
    for idx, (label, thumb) in enumerate(thumbs):
        x = idx * width
        draw.text((x + 4, 4), label, fill=(255, 255, 255))
        canvas.paste(thumb, (x, label_height))
    canvas.save(path)


def compare_arrays(candidate: np.ndarray, current: np.ndarray) -> tuple[float, float]:
    if current.shape != candidate.shape:
        raise ValueError(f"comparison image shape {current.shape} does not match candidate {candidate.shape}")
    exact = float((candidate == current).all(axis=2).mean())
    mean_sum_diff = float(np.abs(candidate.astype(np.int16) - current.astype(np.int16)).sum(axis=2).mean())
    return exact, mean_sum_diff


def active_pixel_count(image: np.ndarray) -> int:
    return int((image != 0).any(axis=2).sum())


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Render a non-destructive Project Rogue map candidate from extracted VPACK JSON."
    )
    parser.add_argument(
        "--mode",
        choices=("raw", "hybrid"),
        default="raw",
        help=(
            "raw renders both floors from packed tile colors; hybrid preserves the overworld "
            "from --compare-image and renders only the underground from packed data."
        ),
    )
    parser.add_argument("--extracted-dir", type=Path, default=DEFAULT_EXTRACTED_DIR)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--thumbnail", type=Path, default=None)
    parser.add_argument("--compare-image", type=Path, default=Path("img") / "Map_Combined.png")
    parser.add_argument("--overworld-qx", type=int, default=0)
    parser.add_argument("--overworld-qy", type=int, default=0)
    parser.add_argument("--overworld-layer", type=int, default=0)
    parser.add_argument("--underground-qx", type=int, default=1)
    parser.add_argument("--underground-qy", type=int, default=0)
    parser.add_argument("--underground-layer", type=int, default=0)
    parser.add_argument(
        "--layer-rule",
        choices=("client-blueprint", "single"),
        default="client-blueprint",
        help=(
            "client-blueprint matches the client minimap atlas: use layer 1 when nonzero, "
            "otherwise layer 0. single uses --overworld-layer and --underground-layer."
        ),
    )
    parser.add_argument(
        "--underground-transform",
        choices=UNDERGROUND_TRANSFORMS,
        default="identity",
        help=(
            "Apply an orientation transform to the rendered underground half. "
            "With source-order q(1,0), identity matches the current underground orientation."
        ),
    )
    parser.add_argument(
        "--palette",
        choices=("tile-rgb", "atlas-average"),
        default="tile-rgb",
        help="Use tile colors from extracted tiles.json or averaged 16x16 cells from gf_json/tiles.json.",
    )
    parser.add_argument("--gf-tiles-json", type=Path, default=DEFAULT_GF_TILES_JSON)
    parser.add_argument(
        "--allow-live-output",
        action="store_true",
        help="Allow writing directly to img/Map_Combined.png after validation.",
    )
    parser.add_argument(
        "--minimum-underground-active-pixels",
        type=int,
        default=MIN_UNDERGROUND_ACTIVE_PIXELS,
        help="Reject hybrid output if the rendered underground has fewer visible pixels than this.",
    )
    parser.add_argument(
        "--water-placeholder",
        action="store_true",
        help="Remap overworld tile id 53 to the water color for old layer-1 experiments.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    extracted_dir = args.extracted_dir
    default_output = DEFAULT_HYBRID_OUTPUT_NAME if args.mode == "hybrid" else DEFAULT_OUTPUT_NAME
    output = args.output or output_with_transform_suffix(extracted_dir / default_output, args.underground_transform)
    thumbnail = args.thumbnail or output_with_transform_suffix(extracted_dir / DEFAULT_THUMBNAIL_NAME, args.underground_transform)
    if not args.allow_live_output and output.resolve() == LIVE_MAP_PATH.resolve():
        raise SystemExit("error: refusing to write directly to img/Map_Combined.png; render to .analysis first")

    map_meta, chunk_map, chunks = load_map_arrays(extracted_dir / "map.json")
    tile_rgb_palette = load_tile_rgb_palette(extracted_dir / "tiles.json")
    colors = (
        load_atlas_average_palette(args.gf_tiles_json, tile_rgb_palette)
        if args.palette == "atlas-average"
        else tile_rgb_palette
    )
    comparison_image = None
    if args.compare_image and args.compare_image.is_file():
        comparison_image = np.asarray(Image.open(args.compare_image).convert("RGB"))

    overworld_ids = render_page(
        chunk_map,
        chunks,
        qx=args.overworld_qx,
        qy=args.overworld_qy,
        layer=args.overworld_layer,
        layer_rule=args.layer_rule,
    )
    underground_ids = render_page(
        chunk_map,
        chunks,
        qx=args.underground_qx,
        qy=args.underground_qy,
        layer=args.underground_layer,
        layer_rule=args.layer_rule,
    )

    if args.water_placeholder:
        overworld_ids = np.where(overworld_ids == 53, 1, overworld_ids)

    overworld = colors[overworld_ids]
    underground = transform_image(colors[underground_ids], args.underground_transform)
    underground_active = active_pixel_count(underground)
    if args.mode == "hybrid":
        if comparison_image is None:
            raise FileNotFoundError("--mode hybrid requires --compare-image to provide the overworld half")
        if comparison_image.shape != (4096, 8192, 3):
            raise ValueError(f"hybrid source image must be 8192x4096 RGB-compatible, got {comparison_image.shape}")
        if underground_active < args.minimum_underground_active_pixels:
            raise SystemExit(
                "error: packed underground render is effectively blank "
                f"({underground_active} visible pixels); refusing hybrid output"
            )
        candidate = np.concatenate([comparison_image[:, :4096], underground], axis=1)
    else:
        candidate = np.concatenate([overworld, underground], axis=1)
    output.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(candidate, "RGB").save(output, optimize=True)

    print(f"source generated_at: {map_meta.get('generated_at')}")
    print(
        "render config: "
        f"palette={args.palette}, "
        f"layout=source-order, "
        f"layer_rule={args.layer_rule}, "
        f"overworld=q({args.overworld_qx},{args.overworld_qy})/layer{args.overworld_layer}, "
        f"underground=q({args.underground_qx},{args.underground_qy})/layer{args.underground_layer}, "
        f"underground_transform={args.underground_transform}"
    )
    print(f"rendered candidate: {output}")
    print(f"candidate size: {candidate.shape[1]}x{candidate.shape[0]}")
    print(f"rendered overworld active pixels: {active_pixel_count(overworld)}")
    print(f"rendered underground active pixels: {underground_active}")

    thumbnail_images = [("Candidate", candidate)]
    if comparison_image is not None:
        exact, mean_sum_diff = compare_arrays(candidate, comparison_image)
        print(f"comparison exact pixels: {exact:.4f}")
        print(f"comparison mean RGB sum diff: {mean_sum_diff:.1f}")
        diff = np.minimum(np.abs(candidate.astype(np.int16) - comparison_image.astype(np.int16)) * 3, 255).astype(
            np.uint8
        )
        thumbnail_images = [("Current", comparison_image), ("Candidate", candidate), ("Diff x3", diff)]

    make_thumbnail(thumbnail_images, thumbnail)
    print(f"thumbnail: {thumbnail}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
