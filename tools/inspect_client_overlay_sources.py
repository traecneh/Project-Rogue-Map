from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


DEFAULT_CLIENT_DIR = Path(r"C:\Users\traec\Desktop\Project Rogue\Client")
DEFAULT_EXTRACTED_DIR = Path(".analysis") / "rogue_data_vpack_2026-07-03"
DEFAULT_DATA_DIR = Path("data")
MANUAL_SITE_OVERLAY_FILES = (
    "zones.json",
    "encounters.json",
    "towns.json",
    "poi.json",
    "caves.json",
    "portals.json",
    "crim_spawns.json",
)
WORLDISH_KEYS = {
    "spawn",
    "spawns",
    "encounter",
    "encounters",
    "zone",
    "zones",
    "region",
    "regions",
    "portal",
    "portals",
    "town",
    "towns",
    "cave",
    "caves",
    "poi",
    "pois",
    "position",
    "positions",
    "location",
    "locations",
    "coord",
    "coords",
    "coordinate",
    "coordinates",
    "map_x",
    "map_y",
    "tile_x",
    "tile_y",
    "chunk_x",
    "chunk_y",
}


def read_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def strings_with_offsets(path: Path) -> list[tuple[int, str]]:
    data = path.read_bytes()
    strings: list[tuple[int, str]] = []
    for match in re.finditer(rb"[ -~]{4,}", data):
        strings.append((match.start(), match.group().decode("latin1", errors="ignore").strip()))
    for match in re.finditer(rb"(?:[ -~]\x00){4,}", data):
        strings.append((match.start(), match.group().decode("utf-16le", errors="ignore").strip()))
    strings.sort(key=lambda item: item[0])
    return strings


def extract_map_label_block(strings: list[tuple[int, str]]) -> list[dict]:
    start = next((offset for offset, value in strings if value == "New Korelth"), None)
    if start is None:
        return []
    end = next((offset for offset, value in strings if offset >= start and value == "Necropolis"), None)
    if end is None:
        end = start + 0x600

    labels = []
    seen: set[str] = set()
    for offset, value in strings:
        if not (start <= offset <= end):
            continue
        if len(value) > 40:
            continue
        if not re.match(r"^[A-Za-z0-9 '@.-]+$", value):
            continue
        if value.lower() in {"critical", "error", "debug", "trace", "warning", "info"}:
            continue
        if value not in seen:
            seen.add(value)
            labels.append({"offset": f"0x{offset:x}", "name": value})
    return labels


def extract_overlay_string_hits(strings: list[tuple[int, str]]) -> list[dict]:
    terms = (
        "elite zone",
        "draw elite",
        "chunkactivitytracker",
        "drawworldmap",
        "safezones.json",
        "locales.json",
        "map.json",
        "zones.json",
        "encounters.json",
        "spawn",
        "portal",
    )
    hits = []
    seen: set[str] = set()
    for offset, value in strings:
        lower = value.lower()
        if any(term in lower for term in terms) and value not in seen:
            seen.add(value)
            hits.append({"offset": f"0x{offset:x}", "value": value[:240]})
    return hits


def manifest_summary(extracted_dir: Path) -> tuple[list[dict], set[str]]:
    manifest = read_json(extracted_dir / "manifest.json")
    files = []
    names = set()
    for item in manifest.get("files", []):
        names.add(item["path"])
        files.append(
            {
                "path": item["path"],
                "original_size": item.get("original_size"),
                "compressed_size": item.get("compressed_size"),
                "sha256": item.get("sha256"),
            }
        )
    return files, names


def collection_summary(path: Path) -> dict:
    data = read_json(path)
    top_fields = []
    collection_counts = {}
    if isinstance(data, dict):
        for key, value in data.items():
            top_fields.append(key)
            if isinstance(value, list):
                collection_counts[key] = len(value)
    return {
        "top_fields": top_fields,
        "collection_counts": collection_counts,
        "worldish_keys": sorted(find_worldish_keys(data)),
    }


def find_worldish_keys(obj) -> set[str]:
    hits: set[str] = set()
    if isinstance(obj, dict):
        for key, value in obj.items():
            key_text = str(key)
            key_lower = key_text.lower()
            if key_lower in WORLDISH_KEYS:
                hits.add(key_text)
            hits.update(find_worldish_keys(value))
    elif isinstance(obj, list):
        for value in obj:
            hits.update(find_worldish_keys(value))
    return hits


def loaded_pack_files_from_log(log_path: Path) -> list[str]:
    if not log_path.exists():
        return []
    loaded = []
    seen = set()
    pattern = re.compile(r"Loading ([A-Za-z0-9_.-]+\.json) from client data pack", re.IGNORECASE)
    for line in log_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        match = pattern.search(line)
        if match:
            name = match.group(1)
            if name not in seen:
                seen.add(name)
                loaded.append(name)
    return loaded


def site_label_names(data_dir: Path) -> dict[str, list[str]]:
    labels = {}
    for filename in ("towns.json", "poi.json", "caves.json", "portals.json", "crim_spawns.json"):
        path = data_dir / filename
        if not path.exists():
            continue
        data = read_json(path)
        names = []
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict) and item.get("name"):
                    names.append(str(item["name"]))
        labels[filename] = sorted(set(names), key=str.casefold)
    return labels


def normalize_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", name.lower())


def compare_labels(executable_labels: list[dict], site_labels: dict[str, list[str]]) -> dict:
    site_by_normalized = {}
    for filename, names in site_labels.items():
        for name in names:
            site_by_normalized.setdefault(normalize_name(name), []).append({"file": filename, "name": name})

    exact_matches = []
    missing = []
    for item in executable_labels:
        label = item["name"]
        matches = site_by_normalized.get(normalize_name(label), [])
        if matches:
            exact_matches.append({"label": label, "matches": matches})
        else:
            missing.append(label)
    return {
        "embedded_label_count": len(executable_labels),
        "exact_or_normalized_matches": exact_matches,
        "not_exactly_in_site_label_files": missing,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Inspect Project Rogue client files for map overlay data sources.")
    parser.add_argument("--client-dir", type=Path, default=DEFAULT_CLIENT_DIR)
    parser.add_argument("--extracted-dir", type=Path, default=DEFAULT_EXTRACTED_DIR)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--output-report", type=Path, default=None)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_report = args.output_report or args.extracted_dir / "client_overlay_source_report.json"
    manifest_files, manifest_names = manifest_summary(args.extracted_dir)
    client_files = sorted(str(path.relative_to(args.client_dir)) for path in args.client_dir.rglob("*") if path.is_file())
    loaded_pack_files = loaded_pack_files_from_log(args.client_dir / "ProjectRogue.log")

    schemas = {}
    for item in manifest_files:
        path = args.extracted_dir / item["path"]
        schemas[item["path"]] = collection_summary(path)

    executable = args.client_dir / "Project Rogue Client.exe"
    executable_strings = strings_with_offsets(executable) if executable.exists() else []
    map_labels = extract_map_label_block(executable_strings)
    overlay_hits = extract_overlay_string_hits(executable_strings)
    site_labels = site_label_names(args.data_dir)

    report = {
        "client_dir": str(args.client_dir),
        "extracted_dir": str(args.extracted_dir),
        "client_file_count": len(client_files),
        "client_files": client_files,
        "data_pack_manifest_files": manifest_files,
        "loaded_pack_files_from_log": loaded_pack_files,
        "manual_site_overlay_files": list(MANUAL_SITE_OVERLAY_FILES),
        "manual_site_overlay_files_present_in_pack": sorted(set(MANUAL_SITE_OVERLAY_FILES) & manifest_names),
        "manual_site_overlay_files_not_pack_owned": sorted(set(MANUAL_SITE_OVERLAY_FILES) - manifest_names),
        "manifest_schemas": schemas,
        "executable_overlay_string_hits": overlay_hits,
        "embedded_map_label_block": map_labels,
        "site_label_files": site_labels,
        "embedded_label_comparison": compare_labels(map_labels, site_labels),
        "conclusion": {
            "pack_contains_manual_zone_or_encounter_tables": bool(set(("zones.json", "encounters.json")) & manifest_names),
            "pack_contains_manual_named_point_tables": bool(
                set(("towns.json", "poi.json", "caves.json", "portals.json", "crim_spawns.json")) & manifest_names
            ),
            "interpretation": (
                "The listed site overlay JSON files are manual project data, not expected VPACK payloads. "
                "The local client pack contains map/safezone/locale grids and entity definition databases, "
                "but no source-of-truth replacement for the manual zone, encounter, town, POI, cave, portal, "
                "or criminal-spawn tables. Executable map-label and elite-zone strings are included only for audit; "
                "this report does not treat them as authoritative inputs for the manual overlays."
            ),
        },
    }

    output_report.parent.mkdir(parents=True, exist_ok=True)
    with output_report.open("w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
        handle.write("\n")

    print(f"client files scanned: {len(client_files)}")
    print(f"data pack files: {len(manifest_files)}")
    print("manual site overlay files in pack:", ", ".join(report["manual_site_overlay_files_present_in_pack"]) or "none")
    print("manual site overlay files not pack-owned:", ", ".join(report["manual_site_overlay_files_not_pack_owned"]))
    print(f"embedded map labels found: {len(map_labels)}")
    print(f"report: {output_report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
