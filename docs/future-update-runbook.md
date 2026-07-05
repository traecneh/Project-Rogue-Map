# Future Update Runbook

Use this when Project Rogue ships a client update and the map needs to be regenerated.

## Assumptions

- Run commands from the repository root.
- Local client install is `C:\Users\traec\Desktop\Project Rogue\Client`.
- Extracted client data is in a dated `.analysis` directory, such as `.analysis\rogue_data_vpack_YYYY-MM-DD`.
- The extracted directory contains `map.json` and `tiles.json`.
- Manual overlay JSON files stay manual unless you are intentionally updating known in-game locations by hand.
- The elite-zone overlay is not part of the current validation path.

## 1. Verify Inputs

```powershell
Test-Path "C:\Users\traec\Desktop\Project Rogue\Client"
Test-Path ".analysis\rogue_data_vpack_YYYY-MM-DD\map.json"
Test-Path ".analysis\rogue_data_vpack_YYYY-MM-DD\tiles.json"
```

All three commands should print `True`.

## 2. Render A Candidate

Render to `.analysis` first. Do not write directly to `img\Map_Combined.png` until the candidate is inspected.

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

The expected current layout is:

- Overworld: `q(0,0)`
- Underground: `q(1,0)`
- Underground transform: `identity`
- Layer rule: `client-blueprint`

If the candidate has the right large shape but wrong individual tiles, check source array order and tile palette handling before trying rotations or flips.

## 3. Inspect The Candidate

Open these files:

- `.analysis\rogue_data_vpack_YYYY-MM-DD\map_candidate_thumbnail.png`
- `.analysis\rogue_data_vpack_YYYY-MM-DD\Map_Combined_candidate.png`

Check both floors at zoomed-in detail. The Underground should use the correct individual tiles, not only a similar silhouette.

## 4. Write The Live Map

Only after the candidate is visually accepted, replace the live image:

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

## 5. Run Map Health Checks

```powershell
python tools\run_map_update_checks.py --extracted-dir .analysis\rogue_data_vpack_YYYY-MM-DD
```

Review any generated report before changing render assumptions:

- `.analysis\rogue_data_vpack_YYYY-MM-DD\map_render_lineage_healthcheck_report.json`
- `.analysis\rogue_data_vpack_YYYY-MM-DD\overlay_alignment_healthcheck_report.json`
- `.analysis\rogue_data_vpack_YYYY-MM-DD\overlay_alignment_healthcheck.png`

## 6. Run The Full Local Suite

```powershell
powershell -ExecutionPolicy Bypass -File tools\run_all_checks.ps1
```

This includes JavaScript syntax checks, helper unit tests, deployment smoke unit tests, search/layer regression coverage, Python unit tests, and the map update health check.

GitHub Actions runs `tools\run_ci_checks.ps1`, which covers repository-contained syntax and unit checks. It does not run the map update health check because `.analysis` extracted client data is local-only.

## 7. Browser Spot Check

Start a local static server:

```powershell
python -m http.server 8001
```

Open `http://localhost:8001/` and check:

- Overworld image loads.
- Underground image loads.
- Towns, POIs, caves, portals, crim spawns, zones, and encounters can be toggled.
- Searching for a monster from the dropdown does not hide already-enabled town or POI layers.

## 8. Deploy And Smoke Test

Commit and push the regenerated map plus any intentional manual overlay edits. After GitHub Pages finishes deploying, run:

```powershell
node tools\deploy_smoke.mjs
```

The smoke check should pass `index.html`, `module app script`, `js/config.js`, `js/app.js`, and `map image`.
