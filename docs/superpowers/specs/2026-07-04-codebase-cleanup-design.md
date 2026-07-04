# Project Rogue Map Codebase Cleanup Design

## Goal

Reduce the risk and cost of future map-app changes by breaking up `js/app.js` into smaller native ES modules while preserving the current static-site deployment model and current user-facing behavior.

Small user-facing fixes are allowed during the cleanup only when they are obvious, tightly scoped, and discovered in the code being moved. Examples include stale UI state, incorrect labels, inconsistent URL state, or accessibility attributes that are clearly wrong.

## Current Context

The app is a static Leaflet map served from GitHub Pages. It has no build step and should stay that way for this cleanup. The map generation/update workflow is now documented and guarded by `tools/run_map_update_checks.py`.

The main frontend risk is that `js/app.js` owns nearly every concern:

- map and pane setup;
- floor switching and coordinate conversion;
- layer groups and layer pills;
- search, suggestions, URL persistence, and monster result focusing;
- monster level filters and chunk labels;
- towns, POIs, portals, caves, zones, crim spawns, measure tools, respawn helper, and screensaver behavior;
- collision hiding and floor-edge label adjustment.

That file has grown large enough that small changes can affect distant behavior, especially where search, layer visibility, floor state, and collision hiding share DOM and Leaflet state.

## Chosen Approach

Use a conservative module split first. Extract low-risk helpers and configuration into native ES modules while keeping `js/app.js` as the Leaflet orchestration layer.

Do not introduce Vite, Webpack, npm dependencies, TypeScript, or a framework. The app should continue to run from a simple static server and from GitHub Pages.

## Phase 1 Module Shape

The first cleanup phase should create small modules with clear boundaries:

- `js/config.js`
  - data paths;
  - image path;
  - floor definitions;
  - shared constants such as chunk size, floor width, search limits, and zoom values.

- `js/dom-utils.js`
  - `clamp`;
  - HTML escaping;
  - CSS variable reads;
  - small DOM helpers that do not depend on Leaflet or app state.

- `js/coordinates.js`
  - map Y conversion;
  - floor lookup and local/global floor X conversion;
  - floor bounds helpers that can be parameterized with `IMG_W`, `IMG_H`, and `toLL`.

- `js/search-utils.js`
  - monster/name normalization;
  - search regex creation;
  - search item ranking primitives;
  - URL search parameter helpers where they can be kept independent from app state.

- `js/monster-utils.js`
  - monster level parsing and filtering helpers;
  - boss/difficulty classification helpers;
  - formatting helpers for monster and zone level display where they are pure.

- `js/app.js`
  - remains the entry module;
  - owns Leaflet map creation;
  - owns mutable app state;
  - owns layer group creation;
  - owns event wiring;
  - calls imported helpers instead of defining every helper inline.

This phase is intentionally not a full feature-module split. Leaflet-heavy systems such as portals, zones, chunk labels, collision hiding, floor switching, and measurement can stay in `app.js` until the low-risk extraction is stable.

## Explicit Non-Goals

Phase 1 should not:

- change default enabled layers;
- change map coordinate math or floor orientation;
- change the visual design;
- rewrite collision hiding;
- split every feature into separate modules;
- introduce a package manager workflow;
- regenerate manual JSON overlay files;
- alter the map image or map-generation tooling.

## Allowed Small Fixes

Small fixes are allowed when found during the split and when they can be tested immediately. Examples:

- stale search or layer visibility state;
- inconsistent ARIA attributes on controls;
- misleading button title text;
- URL search state not matching the visible search field;
- obvious null/undefined guard issues in moved helper code.

Any fix outside the files being touched should be deferred unless it blocks the cleanup.

## Testing Strategy

Before and after the refactor, run:

- `node --check js/app.js`;
- `node tests/search_layer_regression.js`;
- `python -m unittest tests.test_run_map_update_checks`;
- `python tools/run_map_update_checks.py`.

After the module split, add or update lightweight tests for extracted pure helpers where practical. Browser validation should cover:

- app loads on a local static server;
- Overworld and Underground switch correctly;
- default layers render;
- selecting a monster search suggestion keeps enabled Town/POI layers usable;
- a town or POI search can still focus its matching label;
- no relevant console errors.

## Implementation Notes

Use small commits or at least small working slices. A safe order is:

1. Convert `index.html` script loading to `type="module"` without moving logic.
2. Extract constants/config and verify.
3. Extract pure DOM/math helpers and verify.
4. Extract search and monster utility helpers and verify.
5. Review whether a second cleanup phase should split Leaflet-heavy feature modules.

If any extraction creates unclear parameter passing or circular dependencies, stop and keep that code in `app.js` until the dependency boundary is better understood.

## Success Criteria

The cleanup is successful when:

- the app behaves the same for normal users;
- `js/app.js` is meaningfully smaller and easier to scan;
- extracted modules have clear responsibilities;
- no build step is required;
- existing map update checks still pass;
- the monster-search layer regression remains covered;
- obvious small fixes found during the move are covered by verification.
