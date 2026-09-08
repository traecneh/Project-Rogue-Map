"""Build compact, connected walking grids from the same tile layout as the map."""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from render_map_candidate import DEFAULT_EXTRACTED_DIR, load_map_arrays, render_page

BLOCKED_IDS = (0, 1, 53, 60)


def encode_grid(walkable: np.ndarray) -> tuple[bytes, int]:
    """Row runs plus connected-area IDs; four-way connectivity also matches
    eight-way walking when diagonal corner cutting is forbidden."""
    height, width = walkable.shape
    parents = [0]
    runs = []
    offsets = [0]
    previous = []

    def root(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    for row in walkable:
        changes = np.diff(np.pad(row.astype(np.int8), (1, 1)))
        starts = np.flatnonzero(changes == 1)
        ends = np.flatnonzero(changes == -1)
        current = []
        j = 0
        for left, right in zip(starts.tolist(), ends.tolist()):
            label = len(parents)
            parents.append(label)
            while j < len(previous) and previous[j][1] <= left:
                j += 1
            k = j
            while k < len(previous) and previous[k][0] < right:
                parents[root(label)] = root(previous[k][2])
                k += 1
            current.append((left, right, label))
        runs.extend(current)
        previous = current
        offsets.append(len(runs))

    regions = {}
    payload = bytearray(struct.pack('<4sIII', b'PRN1', width, height, len(runs)))
    payload.extend(struct.pack(f'<{len(offsets)}I', *offsets))
    for left, right, label in runs:
        component = regions.setdefault(root(label), len(regions) + 1)
        payload.extend(struct.pack('<HHI', left, right, component))
    return bytes(payload), len(regions)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--extracted-dir', type=Path, default=DEFAULT_EXTRACTED_DIR)
    parser.add_argument('--output-dir', type=Path, default=Path('data/navigation'))
    parser.add_argument('--check', action='store_true', help='Verify committed grids without writing files.')
    args = parser.parse_args()
    _, chunk_map, chunks = load_map_arrays(args.extracted_dir / 'map.json')
    manifest = {'version': 1, 'blockedTileIds': list(BLOCKED_IDS), 'sourceMapSha256': hashlib.sha256((args.extracted_dir / 'map.json').read_bytes()).hexdigest(), 'floors': {}}
    outputs = {}
    for floor, qx in [('overworld', 0), ('underground', 1)]:
        ids = render_page(chunk_map, chunks, qx=qx, qy=0, layer=0, layer_rule='client-blueprint')
        walkable = ~np.isin(ids, BLOCKED_IDS)
        payload, regions = encode_grid(walkable)
        outputs[f'{floor}.bin'] = payload
        manifest['floors'][floor] = {'file': f'{floor}.bin', 'offsetX': qx * 4096, 'width': 4096, 'height': 4096, 'sha256': hashlib.sha256(payload).hexdigest(), 'regions': regions, 'walkableTiles': int(walkable.sum())}
        print(f'{floor}: {walkable.sum():,} walkable tiles, {regions:,} connected areas, {len(payload):,} bytes')
    outputs['manifest.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    # Build exact cluster crossing costs offline; browsers only load/search the
    # resulting graph. Use a temporary directory so --check never mutates data.
    with tempfile.TemporaryDirectory(prefix='rogue-navigation-') as temporary:
        directory = Path(temporary)
        for name, payload in outputs.items():
            (directory / name).write_bytes(payload)
        subprocess.run(['node', str(Path(__file__).with_name('generate_navigation_hierarchy.mjs')), str(directory)], check=True)
        outputs = {path.name: path.read_bytes() for path in directory.iterdir()}
    if not args.check:
        args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, payload in outputs.items():
        path = args.output_dir / name
        if args.check:
            if not path.exists() or path.read_bytes() != payload:
                raise SystemExit(f'Navigation data is stale: {path}')
        else:
            path.write_bytes(payload)


if __name__ == '__main__':
    main()
