from __future__ import annotations

import argparse
import base64
import json
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


DEFAULT_EXTRACTED_DIR = Path(".analysis") / "rogue_data_vpack_2026-07-03"
DEFAULT_CURRENT_MAP = Path("img") / "Map_Combined.png"
DEFAULT_BASELINE_MAP = Path(".analysis") / "Map_Combined_initial.png"
DEFAULT_OLD_MAPDAT = Path(r"C:\Users\traec\Desktop\Client\data\map.dat")
DEFAULT_CLIENT_LOG = Path(r"C:\Users\traec\Desktop\Project Rogue\Client\ProjectRogue.log")
DEFAULT_REPORT = DEFAULT_EXTRACTED_DIR / "map_render_lineage_report.json"
DEFAULT_RECONSTRUCTED_MAPDAT = DEFAULT_EXTRACTED_DIR / "reconstructed_map.dat"

MAP_W = 8192
MAP_H = 4096
FLOOR_W = 4096
CHUNK = 16
PAGE_CHUNKS = 256


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_map_payload(path: Path) -> tuple[dict[str, Any], bytes, bytes, np.ndarray, np.ndarray]:
    data = read_json(path)
    chunks_bytes = base64.b64decode(data["chunks"])
    chunk_map_bytes = base64.b64decode(data["chunk_map"])
    chunk_map = np.frombuffer(chunk_map_bytes, dtype="<u2").reshape(
        int(data["chunk_map_width"]),
        int(data["chunk_map_height"]),
    )
    chunks = np.frombuffer(chunks_bytes, dtype="<u2").reshape(
        int(data["layer_count"]),
        int(data["chunk_count"]),
        int(data["chunk_tile_height"]),
        int(data["chunk_tile_width"]),
    )
    return data, chunks_bytes, chunk_map_bytes, chunk_map, chunks


def load_tile_palette(path: Path) -> tuple[np.ndarray, set[int]]:
    data = read_json(path)
    colors = np.zeros((4096, 3), dtype=np.uint8)
    packed_colors: set[int] = set()
    for tile in data["tiles"]:
        tile_id = int(tile["id"])
        color = tile["color"]
        rgb = (int(color["r"]), int(color["g"]), int(color["b"]))
        colors[tile_id] = rgb
        packed_colors.add((rgb[0] << 16) | (rgb[1] << 8) | rgb[2])
    return colors, packed_colors


def packed_rgb(image: np.ndarray) -> np.ndarray:
    return (
        (image[:, :, 0].astype(np.uint32) << 16)
        | (image[:, :, 1].astype(np.uint32) << 8)
        | image[:, :, 2].astype(np.uint32)
    )


def image_stats(image: np.ndarray) -> dict[str, Any]:
    packed = packed_rgb(image)
    values, counts = np.unique(packed, return_counts=True)
    top = sorted(zip(values.tolist(), counts.tolist()), key=lambda item: item[1], reverse=True)[:20]
    return {
        "shape": list(image.shape),
        "active_pixels": int((packed != 0).sum()),
        "unique_colors": int(len(values)),
        "top_colors": [
            {
                "rgb": [int((value >> 16) & 255), int((value >> 8) & 255), int(value & 255)],
                "pixels": int(count),
            }
            for value, count in top
        ],
    }


def compare_bytes(left: bytes, right: bytes) -> dict[str, Any]:
    if len(left) != len(right):
        size = min(len(left), len(right))
    else:
        size = len(left)
    equal = sum(1 for idx in range(size) if left[idx] == right[idx])
    first_mismatches = []
    for idx in range(size):
        if left[idx] != right[idx]:
            first_mismatches.append({"offset": idx, "left": left[idx], "right": right[idx]})
            if len(first_mismatches) == 10:
                break
    return {
        "left_bytes": len(left),
        "right_bytes": len(right),
        "compared_bytes": size,
        "equal_bytes": equal,
        "equality_ratio": equal / size if size else 0.0,
        "first_mismatches": first_mismatches,
    }


def compare_images(candidate: np.ndarray, target: np.ndarray) -> dict[str, Any]:
    candidate_packed = packed_rgb(candidate)
    target_packed = packed_rgb(target)
    candidate_mask = candidate_packed != 0
    target_mask = target_packed != 0
    equal = candidate_packed == target_packed
    intersection = int((candidate_mask & target_mask).sum())
    union = int((candidate_mask | target_mask).sum())
    return {
        "candidate_active_pixels": int(candidate_mask.sum()),
        "target_active_pixels": int(target_mask.sum()),
        "active_intersection_pixels": intersection,
        "active_iou": intersection / union if union else 0.0,
        "exact_pixel_ratio": float(equal.mean()),
        "target_active_exact_ratio": float(equal[target_mask].mean()) if target_mask.any() else 0.0,
    }


def render_current_assumption_underground(chunks: np.ndarray, chunk_map: np.ndarray, colors: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    ids = chunk_map[PAGE_CHUNKS : PAGE_CHUNKS * 2, 0:PAGE_CHUNKS]
    base = chunks[0, ids, :, :]
    overlay = chunks[1, ids, :, :]
    tile_ids = np.where(overlay != 0, overlay, base).transpose(1, 3, 0, 2).reshape(FLOOR_W, FLOOR_W)
    return tile_ids, colors[tile_ids]


def tile_mismatch_summary(candidate_tile_ids: np.ndarray, candidate_rgb: np.ndarray, current_right: np.ndarray) -> list[dict[str, Any]]:
    candidate_packed = packed_rgb(candidate_rgb)
    current_packed = packed_rgb(current_right)
    overlap = (candidate_packed != 0) & (current_packed != 0)
    if not overlap.any():
        return []

    ids = candidate_tile_ids[overlap]
    current_values = current_packed[overlap]
    unique_ids, counts = np.unique(ids, return_counts=True)
    top_ids = [int(tile_id) for tile_id, _ in sorted(zip(unique_ids.tolist(), counts.tolist()), key=lambda item: item[1], reverse=True)[:30]]

    out: list[dict[str, Any]] = []
    for tile_id in top_ids:
        mask = ids == tile_id
        values = current_values[mask]
        dominant_value, dominant_count = Counter(values.tolist()).most_common(1)[0]
        candidate_value = int(candidate_packed[overlap][mask][0])
        out.append(
            {
                "candidate_tile_id": tile_id,
                "overlap_pixels": int(mask.sum()),
                "candidate_rgb": [
                    int((candidate_value >> 16) & 255),
                    int((candidate_value >> 8) & 255),
                    int(candidate_value & 255),
                ],
                "dominant_current_rgb": [
                    int((dominant_value >> 16) & 255),
                    int((dominant_value >> 8) & 255),
                    int(dominant_value & 255),
                ],
                "dominant_fraction": float(dominant_count / mask.sum()),
            }
        )
    return out


def color_membership(image: np.ndarray, tile_colors: set[int]) -> dict[str, Any]:
    packed = packed_rgb(image)
    values, counts = np.unique(packed, return_counts=True)
    in_palette = np.array([int(value) in tile_colors for value in values], dtype=bool)
    return {
        "unique_colors": int(len(values)),
        "unique_colors_in_tile_palette": int(in_palette.sum()),
        "pixel_ratio_in_tile_palette": float(counts[in_palette].sum() / counts.sum()) if counts.sum() else 0.0,
    }


def baseline_relationship(baseline: np.ndarray, current: np.ndarray) -> dict[str, Any]:
    baseline_right = baseline[:, FLOOR_W:]
    current_right = current[:, FLOOR_W:]
    current_mask = packed_rgb(current_right) != 0
    baseline_mask = packed_rgb(baseline_right) != 0
    equal = packed_rgb(current_right) == packed_rgb(baseline_right)
    return {
        "baseline_right_active_pixels": int(baseline_mask.sum()),
        "current_right_active_pixels": int(current_mask.sum()),
        "current_active_pixels_equal_baseline_right": int((equal & current_mask).sum()),
        "current_active_exact_ratio_against_baseline_right": float(equal[current_mask].mean()) if current_mask.any() else 0.0,
        "baseline_right_pixels_removed_in_current": int((baseline_mask & ~current_mask).sum()),
    }


def relevant_log_lines(path: Path) -> list[str]:
    if not path.is_file():
        return []
    wanted = (
        "Loaded Map chunks",
        "Loaded Map chunk map",
        "Creating chunk blueprints",
        "Map chunk blueprints created",
        "Full map surface created",
        "Full map GPU cache",
    )
    lines = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if any(token in line for token in wanted):
            lines.append(line)
    return lines


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Analyze Project Rogue map render lineage and guard against unsafe VPACK map candidates."
    )
    parser.add_argument("--extracted-dir", type=Path, default=DEFAULT_EXTRACTED_DIR)
    parser.add_argument("--current-map", type=Path, default=DEFAULT_CURRENT_MAP)
    parser.add_argument("--baseline-map", type=Path, default=DEFAULT_BASELINE_MAP)
    parser.add_argument("--old-mapdat", type=Path, default=DEFAULT_OLD_MAPDAT)
    parser.add_argument("--client-log", type=Path, default=DEFAULT_CLIENT_LOG)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--write-reconstructed-mapdat", type=Path, default=None)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    extracted_dir = args.extracted_dir
    map_meta, chunks_bytes, chunk_map_bytes, chunk_map, chunks = load_map_payload(extracted_dir / "map.json")
    colors, tile_color_set = load_tile_palette(extracted_dir / "tiles.json")
    reconstructed_mapdat = chunks_bytes + chunk_map_bytes

    current = np.asarray(Image.open(args.current_map).convert("RGB"))
    if current.shape != (MAP_H, MAP_W, 3):
        raise ValueError(f"expected current map to be 8192x4096 RGB, got {current.shape}")

    candidate_tile_ids, candidate_right = render_current_assumption_underground(chunks, chunk_map, colors)
    current_right = current[:, FLOOR_W:]

    report: dict[str, Any] = {
        "map_payload": {
            "schema_version": map_meta.get("schema_version"),
            "generated_at": map_meta.get("generated_at"),
            "chunk_count": map_meta.get("chunk_count"),
            "layer_count": map_meta.get("layer_count"),
            "chunks_bytes": len(chunks_bytes),
            "chunk_map_bytes": len(chunk_map_bytes),
            "reconstructed_mapdat_bytes": len(reconstructed_mapdat),
        },
        "current_map": {
            "full": image_stats(current),
            "overworld": image_stats(current[:, :FLOOR_W]),
            "underground": image_stats(current_right),
            "color_membership": color_membership(current, tile_color_set),
        },
        "candidate_guard": {
            "assumption": "source-order q(1,0), client blueprint rule: layer 1 when nonzero else layer 0",
            "comparison_to_current_underground": compare_images(candidate_right, current_right),
            "top_tile_mismatches": tile_mismatch_summary(candidate_tile_ids, candidate_right, current_right),
        },
        "client_log_evidence": relevant_log_lines(args.client_log),
    }

    if args.old_mapdat.is_file():
        old_bytes = args.old_mapdat.read_bytes()
        report["old_mapdat_comparison"] = compare_bytes(old_bytes, reconstructed_mapdat)
        if len(old_bytes) == len(reconstructed_mapdat):
            old_chunk_map = np.frombuffer(old_bytes[len(chunks_bytes) :], dtype="<u2").reshape(chunk_map.shape)
            report["old_chunk_map_comparison"] = {
                "word_equality_ratio": float((old_chunk_map == chunk_map).mean()),
                "old_unique_chunk_ids": int(len(np.unique(old_chunk_map))),
                "new_unique_chunk_ids": int(len(np.unique(chunk_map))),
            }

    if args.baseline_map.is_file():
        baseline = np.asarray(Image.open(args.baseline_map).convert("RGB"))
        if baseline.shape == current.shape:
            report["baseline_map_relationship"] = baseline_relationship(baseline, current)
        else:
            report["baseline_map_relationship"] = {"error": f"shape mismatch: {baseline.shape} != {current.shape}"}

    if args.write_reconstructed_mapdat is not None:
        args.write_reconstructed_mapdat.parent.mkdir(parents=True, exist_ok=True)
        args.write_reconstructed_mapdat.write_bytes(reconstructed_mapdat)
        report["written_reconstructed_mapdat"] = str(args.write_reconstructed_mapdat)

    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2), encoding="utf-8", newline="\n")

    guard = report["candidate_guard"]["comparison_to_current_underground"]
    print(f"wrote report: {args.report}")
    print(f"reconstructed map.dat bytes: {len(reconstructed_mapdat)}")
    if "old_mapdat_comparison" in report:
        print(f"old map.dat byte equality: {report['old_mapdat_comparison']['equality_ratio']:.4%}")
    print(
        "candidate current-underground active exact: "
        f"{guard['target_active_exact_ratio']:.4%}; active IoU: {guard['active_iou']:.4%}"
    )
    print(
        "current map colors in tile palette: "
        f"{report['current_map']['color_membership']['pixel_ratio_in_tile_palette']:.4%}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
