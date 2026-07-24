# Project Rogue Map

Static Leaflet map for Project Rogue.

The map image is generated from local Project Rogue client data. The overlay JSON files are manually maintained to line up with known in-game locations and should not be regenerated automatically.

## Important Paths

- Local client install: `C:\Users\traec\Desktop\Project Rogue\Client`
- Current extracted VPACK data: `.analysis\rogue_data_vpack_2026-07-03`
- Live map image served by the app: `img\Map_Combined.png`
- App entry point: `index.html`
- Main app logic: `js\app.js`

Frontend JavaScript uses native browser ES modules. There is no bundled build step; run the app through a static server rather than opening `index.html` directly from disk.

GitHub Pages serves this as a static site. Keep the root `.nojekyll` file so Pages does not run Jekyll processing over the native ES module files.

The extracted data directory must contain at least `map.json` and `tiles.json`. The renderer can also read the client atlas from `C:\Users\traec\Desktop\Project Rogue\Client\gf_json\tiles.json` when atlas-average experiments are needed, but the current live map uses the extracted tile RGB colors.

For the exact future update sequence, use the [future update runbook](docs/future-update-runbook.md).

## Map Render Rules

These are the rules that made the current Overworld and Underground line up correctly:

- Chunk source order is `ChunkMap[x][y]`.
- Tile source order is `Chunks[layer][chunk][x][y]`.
- Overworld uses page `q(0,0)`.
- Underground uses page `q(1,0)`.
- The map image uses no rotation or flip for the Underground. `identity` is the correct transform.
- The client blueprint layer rule is used: layer 1 wins when nonzero, otherwise layer 0 is used.
- The combined image is `8192x4096`: Overworld on the left, Underground on the right.

Do not rotate, flip, or transpose the Underground unless a future client update breaks these checks and the rendered candidate proves a different source layout.

## Coordinate Rules

The app maps game Y coordinates into Leaflet image latitude with `IMG_H - y`. That applies to both floors in `js/app.js`; do not special-case Underground marker Y in the app.

Coordinate deep links use `?x=<game-x>&y=<game-y>`. An optional `label` parameter displays a short name beside the focused marker, for example `?x=3415&y=3722&label=Town+Guide`.

The overlay checker has two modes because it works directly against PNG pixels:

- `invert` means app-style Leaflet coordinates.
- `direct` means direct map-pixel rows.

For the current Underground PNG, overlay QA must use `--underground-y-mode direct`. This does not contradict the app code; it is checking a different coordinate space.

## Manual Data Policy

These files are hand-maintained overlays and should remain manual:

- `data\zones.json`
- `data\encounters.json`
- `data\towns.json`
- `data\poi.json`
- `data\caves.json`
- `data\portals.json`
- `data\crim_spawns.json`

The elite-zone overlay is not part of the current validation path.

## Future Client Update Workflow

1. Install or update the local client at `C:\Users\traec\Desktop\Project Rogue\Client`.
2. Extract the new client VPACK data into a dated directory under `.analysis`, for example `.analysis\rogue_data_vpack_YYYY-MM-DD`.
3. Render a non-destructive candidate:

   ```powershell
   python tools\render_map_candidate.py `
     --extracted-dir .analysis\rogue_data_vpack_YYYY-MM-DD `
     --output .analysis\rogue_data_vpack_YYYY-MM-DD\Map_Combined_candidate.png `
     --thumbnail .analysis\rogue_data_vpack_YYYY-MM-DD\map_candidate_thumbnail.png `
     --layer-rule client-blueprint `
     --overworld-qx 0 --overworld-qy 0 `
     --underground-qx 1 --underground-qy 0 `
     --underground-transform identity
   ```

4. Inspect the thumbnail and candidate. The Underground should use the correct individual tiles, not just a similar shape.
5. After visual validation, write the live map:

   ```powershell
   python tools\render_map_candidate.py `
     --extracted-dir .analysis\rogue_data_vpack_YYYY-MM-DD `
     --output img\Map_Combined.png `
     --allow-live-output `
     --layer-rule client-blueprint `
     --overworld-qx 0 --overworld-qy 0 `
     --underground-qx 1 --underground-qy 0 `
     --underground-transform identity
   ```

6. Run the full post-update health check:

   ```powershell
   python tools\run_map_update_checks.py --extracted-dir .analysis\rogue_data_vpack_YYYY-MM-DD
   ```

7. Start a local server and spot-check both floors:

   ```powershell
   python -m http.server 8001
   ```

   Open `http://localhost:8001/`, switch between Overworld and Underground, and confirm the image and overlay layers load.

8. Commit and push the regenerated map plus any intentional manual overlay updates.

## Verification

Run the full local check suite with:

```powershell
powershell -ExecutionPolicy Bypass -File tools\run_all_checks.ps1
```

GitHub Actions runs the repository-contained subset with:

```powershell
powershell -ExecutionPolicy Bypass -File tools\run_ci_checks.ps1
```

The CI subset does not replace the full local map health check because the extracted client data under `.analysis` is local-only.

Frontend helper unit tests can be run with:

```powershell
node --test tests\pure_utils.test.mjs
```

After pushing to GitHub Pages, run the deployment smoke check with:

```powershell
node tools\deploy_smoke.mjs
```

The `Live deploy smoke` GitHub Actions workflow also runs this check automatically on `main` pushes, with retries for Pages/CDN propagation delays. It can also be started manually from the Actions tab.

To check a different static deployment URL, pass it as the first argument:

```powershell
node tools\deploy_smoke.mjs https://example.com/Project-Rogue-Map/
```

## Health Check

`tools\run_map_update_checks.py` is the one-command regression guard for future map updates. It verifies:

- all Python map tools compile;
- a fresh render matches `img\Map_Combined.png`;
- the lineage guard still sees the Underground as source-order `q(1,0)` with `identity` orientation;
- live map colors are still from the extracted tile palette;
- manual overlay coordinates are in bounds;
- Underground POIs, portals, caves, towns, and spawn points are near visible terrain;
- Underground zone and encounter chunks still substantially overlap visible terrain.

The command writes diagnostic artifacts into the extracted data directory:

- `map_update_healthcheck_render.png`
- `map_update_healthcheck_thumbnail.png`
- `map_render_lineage_healthcheck_report.json`
- `overlay_alignment_healthcheck_report.json`
- `overlay_alignment_healthcheck.png`

If this check fails after a future update, inspect the candidate thumbnail and the two JSON reports before changing orientation rules. A shape match with wrong individual tiles usually means the chunk or tile array order is wrong, not that the Underground needs a simple rotate or flip.
