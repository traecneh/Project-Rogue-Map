# Project Rogue Map Codebase Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `js/app.js` into smaller native ES modules without changing the static GitHub Pages deployment model or normal user behavior.

**Architecture:** Keep `js/app.js` as the Leaflet orchestration entrypoint. Extract only configuration and pure helpers first, then verify the browser flow before considering any Leaflet-heavy feature split.

**Tech Stack:** Static HTML/CSS/JavaScript, native browser ES modules, Leaflet 1.9.4, Node.js for syntax/regression checks, Python tooling for map health checks.

---

## File Structure

Create:

- `package.json` - Node metadata only, used so Node parses project `.js` files as ES modules during checks. It must contain no dependencies and no build step.
- `js/config.js` - exported app constants, data paths, floor definitions, and search ordering constants.
- `js/dom-utils.js` - pure and DOM-light helpers: `debounce`, `escHtml`, `clamp`, and `readCssVar`.
- `js/coordinates.js` - pure coordinate and floor helper functions that accept current image dimensions as parameters.
- `js/search-utils.js` - pure search normalization, regex creation, search entry lookup, and suggestion ranking helpers.
- `js/monster-utils.js` - pure monster level, monster filter, boss threshold, and zone difficulty helpers.

Modify:

- `index.html` - load `js/app.js` as a native module.
- `js/app.js` - import helpers from the new modules and retain Leaflet setup, layer creation, mutable state, rendering, and event wiring.
- `tests/search_layer_regression.js` - rename to `tests/search_layer_regression.mjs` and load `js/app.js` as an ES module instead of string-injecting a test API.
- `README.md` - update the verification command from `node tests\search_layer_regression.js` to `node tests\search_layer_regression.mjs` if the README mentions that command after the refactor.

Keep unchanged:

- map generation tools;
- manual JSON overlay files;
- `img/Map_Combined.png`;
- CSS visual styling unless a small bug is found in directly touched markup/state.

---

### Task 1: Convert The App Entry To Native Module Loading

**Files:**

- Create: `package.json`
- Modify: `index.html`
- Modify: `js/app.js`
- Rename: `tests/search_layer_regression.js` to `tests/search_layer_regression.mjs`

- [ ] **Step 1: Create Node module metadata**

Create `package.json` with exactly this content:

```json
{
  "private": true,
  "type": "module"
}
```

This is not a package-manager workflow. Do not add dependencies, scripts, lockfiles, or build tooling.

- [ ] **Step 2: Change the app script tag to native module loading**

In `index.html`, replace:

```html
<script src="./js/app.js"></script>
```

with:

```html
<script type="module" src="./js/app.js"></script>
```

- [ ] **Step 3: Add a guarded test API exposure**

In `js/app.js`, add this function after the search/focus functions have been declared and before the image-load section starts:

```js
  function exposeTestApi() {
    if (typeof window === 'undefined') return;
    if (!window.__PROJECT_ROGUE_TEST_HOOKS__) return;
    window.__PROJECT_ROGUE_TEST_HOOKS__.api = {
      commitSearch,
      groups: { towns, poisFG },
      elements: { searchInput, pillTowns, pillPois }
    };
  }
```

Then call it immediately before the closing `})();` at the bottom of `js/app.js`:

```js
  exposeTestApi();
})();
```

The hook must do nothing unless `window.__PROJECT_ROGUE_TEST_HOOKS__` already exists.

- [ ] **Step 4: Rename the regression test to ESM**

Run:

```powershell
git mv tests\search_layer_regression.js tests\search_layer_regression.mjs
```

- [ ] **Step 5: Replace CommonJS imports in the regression test**

In `tests/search_layer_regression.mjs`, replace:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const appPath = path.join(root, 'js', 'app.js');
```

with:

```js
import assert from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const appPath = path.join(root, 'js', 'app.js');
```

- [ ] **Step 6: Replace source-string VM execution in the regression test**

In `tests/search_layer_regression.mjs`, remove the block that reads `js/app.js`, replaces the final IIFE tail, and calls `vm.runInNewContext`.

Replace it with this module import block after `const harness = createHarness();`:

```js
Object.assign(globalThis, harness.context);
globalThis.window.__PROJECT_ROGUE_TEST_HOOKS__ = {};

await import(pathToFileURL(appPath).href);

const api = globalThis.window.__PROJECT_ROGUE_TEST_HOOKS__.api;
assert.ok(api, 'app test API was not exposed');
```

Keep the existing fake DOM, fake Leaflet harness, marker creation, `api.commitSearch({ name: 'Death Tyrant', type: 'monster', level: 45 }, { focus: false, exact: true })`, and assertions below that block.

- [ ] **Step 7: Run the module conversion checks**

Run:

```powershell
node --check js\app.js
node tests\search_layer_regression.mjs
```

Expected:

- `node --check js\app.js` exits `0`.
- `node tests\search_layer_regression.mjs` exits `0`.

- [ ] **Step 8: Browser smoke check**

Start a local static server:

```powershell
python -m http.server 8010
```

Open `http://localhost:8010/` and verify:

- the map image loads;
- the control panel renders;
- Towns and POIs are on by default;
- no browser console error says that `L` is undefined or that module loading failed.

- [ ] **Step 9: Commit Task 1**

Run:

```powershell
git add package.json index.html js\app.js tests\search_layer_regression.mjs
git commit -m "Load app as native module"
```

---

### Task 2: Extract Static Configuration

**Files:**

- Create: `js/config.js`
- Modify: `js/app.js`

- [ ] **Step 1: Write the config module**

Create `js/config.js` with exactly this content:

```js
export const IMG_PATH = './img/Map_Combined.png';

export const DATA = {
  towns: './data/towns.json',
  portals: './data/portals.json',
  encounters: './data/encounters.json',
  caves: './data/caves.json',
  zones: './data/zones.json',
  pois: './data/poi.json',
  crim: './data/crim_spawns.json',
  monsterLvls: './data/monster_levels.json'
};

export const INVERT_Y = true;
export const ZOOM_OUT_EXTRA = 2;
export const MATCH_ZINDEX_OFFSET = 10000;
export const FLOOR_WIDTH = 4096;
export const FLOOR_VIEW_PADDING_X = 288;
export const FLOOR_VIEW_PADDING_Y = 224;

export const FLOORS = {
  overworld: { key: 'overworld', label: 'Overworld', minX: 0, maxX: FLOOR_WIDTH, offset: 0 },
  underground: { key: 'underground', label: 'Underground', minX: FLOOR_WIDTH, maxX: FLOOR_WIDTH * 2, offset: FLOOR_WIDTH }
};

export const MONSTER_FILTER_HINT_DEFAULT = 'Showing all levels. Set min/max to filter.';
export const MONSTER_FILTER_HINT_UNAVAILABLE = 'Monster level data unavailable.';
export const MONSTER_FILTER_HINT_NEED_RANGE = 'Set min/max to use Exclusive mode.';

export const CHUNK_SIZE = 16;
export const MIN_CHUNK_SCREEN_PX = 26;
export const SEARCH_LABEL_MIN_PX = MIN_CHUNK_SCREEN_PX + 6;
export const SEARCH_CLUSTER_RADIUS = 1;
export const SEARCH_SUGGESTION_LIMIT = 12;
export const SEARCH_TYPE_ORDER = { monster: 0, town: 1, poi: 2 };
```

- [ ] **Step 2: Import config in `js/app.js`**

At the top of `js/app.js`, after the `/* global L */` comment block and before `(() => {`, add:

```js
import {
  CHUNK_SIZE,
  DATA,
  FLOOR_VIEW_PADDING_X,
  FLOOR_VIEW_PADDING_Y,
  FLOOR_WIDTH,
  FLOORS,
  IMG_PATH,
  INVERT_Y,
  MATCH_ZINDEX_OFFSET,
  MIN_CHUNK_SCREEN_PX,
  MONSTER_FILTER_HINT_DEFAULT,
  MONSTER_FILTER_HINT_NEED_RANGE,
  MONSTER_FILTER_HINT_UNAVAILABLE,
  SEARCH_CLUSTER_RADIUS,
  SEARCH_LABEL_MIN_PX,
  SEARCH_SUGGESTION_LIMIT,
  SEARCH_TYPE_ORDER,
  ZOOM_OUT_EXTRA
} from './config.js';
```

- [ ] **Step 3: Remove duplicated constants from `js/app.js`**

Delete the existing declarations for:

```js
  const IMG_PATH = './img/Map_Combined.png';
  const DATA = {
    towns:      './data/towns.json',
    portals:    './data/portals.json',
    encounters: './data/encounters.json',
    caves:      './data/caves.json',
    zones:      './data/zones.json',
    pois:       './data/poi.json',
    crim:       './data/crim_spawns.json',
    monsterLvls:'./data/monster_levels.json'
  };

  const INVERT_Y = true;
  const ZOOM_OUT_EXTRA = 2;
  const MATCH_ZINDEX_OFFSET = 10000;
  const FLOOR_WIDTH = 4096;
  const FLOOR_VIEW_PADDING_X = 288;
  const FLOOR_VIEW_PADDING_Y = 224;
  const FLOORS = {
    overworld: { key: 'overworld', label: 'Overworld', minX: 0, maxX: FLOOR_WIDTH, offset: 0 },
    underground: { key: 'underground', label: 'Underground', minX: FLOOR_WIDTH, maxX: FLOOR_WIDTH * 2, offset: FLOOR_WIDTH }
  };
  const MONSTER_FILTER_HINT_DEFAULT = 'Showing all levels. Set min/max to filter.';
  const MONSTER_FILTER_HINT_UNAVAILABLE = 'Monster level data unavailable.';
  const MONSTER_FILTER_HINT_NEED_RANGE = 'Set min/max to use Exclusive mode.';

  const CHUNK_SIZE = 16;
  const MIN_CHUNK_SCREEN_PX = 26;
  const SEARCH_LABEL_MIN_PX = MIN_CHUNK_SCREEN_PX + 6;
```

Also delete the current local declarations for:

```js
  const SEARCH_CLUSTER_RADIUS = 1;
  const SEARCH_SUGGESTION_LIMIT = 12;
  const SEARCH_TYPE_ORDER = { monster: 0, town: 1, poi: 2 };
```

- [ ] **Step 4: Run config extraction checks**

Run:

```powershell
node --check js\config.js
node --check js\app.js
node tests\search_layer_regression.mjs
```

Expected: all commands exit `0`.

- [ ] **Step 5: Browser smoke check**

Reload `http://localhost:8010/` and verify:

- the app loads;
- data fetches still reach `./data/*.json`;
- search suggestions still include `Death Tyrant`;
- layer buttons still show the expected defaults.

- [ ] **Step 6: Commit Task 2**

Run:

```powershell
git add js\config.js js\app.js
git commit -m "Extract app configuration"
```

---

### Task 3: Extract DOM And Utility Helpers

**Files:**

- Create: `js/dom-utils.js`
- Modify: `js/app.js`

- [ ] **Step 1: Write the DOM utility module**

Create `js/dom-utils.js` with exactly this content:

```js
export function debounce(fn, ms = 120) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function escHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

export function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

export function readCssVar(name) {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  if (!root) return '';
  return getComputedStyle(root).getPropertyValue(name).trim();
}
```

- [ ] **Step 2: Import DOM utilities in `js/app.js`**

Add this import after the config import:

```js
import { clamp, debounce, escHtml, readCssVar } from './dom-utils.js';
```

- [ ] **Step 3: Remove duplicated helper definitions from `js/app.js`**

Delete these existing local definitions:

```js
  const debounce = (fn, ms = 120) => { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; };
  const escHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const readCssVar = name => {
    const root = typeof document !== 'undefined' ? document.documentElement : null;
    if (!root) return '';
    return getComputedStyle(root).getPropertyValue(name).trim();
  };
```

Keep these local functions in `js/app.js` because they are app-specific wrappers around `readCssVar`:

```js
  const getZoneColor = () => readCssVar('--zone-color') || '#f59e0b';
  const getCrimColor = () => readCssVar('--crim-color') || '#fb7185';
```

- [ ] **Step 4: Run DOM utility checks**

Run:

```powershell
node --check js\dom-utils.js
node --check js\app.js
node tests\search_layer_regression.mjs
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit Task 3**

Run:

```powershell
git add js\dom-utils.js js\app.js
git commit -m "Extract DOM utilities"
```

---

### Task 4: Extract Coordinate And Floor Helpers

**Files:**

- Create: `js/coordinates.js`
- Modify: `js/app.js`

- [ ] **Step 1: Write the coordinate utility module**

Create `js/coordinates.js` with exactly this content:

```js
export function mapLat(y, imageHeight, invertY) {
  return invertY ? imageHeight - y : y;
}

export function gameXYFromLatLng(latlng, { imageWidth, imageHeight, invertY, clamp }) {
  const x = clamp(Math.round(latlng.lng), 0, imageWidth);
  const yTop = clamp(Math.round(latlng.lat), 0, imageHeight);
  return [x, invertY ? imageHeight - yTop : yTop];
}

export function floorConfig(floors, floor) {
  return floors[floor] || floors.overworld;
}

export function floorForX(x, floorWidth) {
  return Number.isFinite(x) && x >= floorWidth ? 'underground' : 'overworld';
}

export function floorLabelForX(x, floorWidth) {
  return floorForX(x, floorWidth) === 'underground' ? 'UG' : 'OW';
}

export function floorLocalX(x, floor, floors) {
  return x - floorConfig(floors, floor).offset;
}

export function globalFloorX(localX, floor, floors) {
  return floorConfig(floors, floor).offset + localX;
}

export function clampFloorX(x, floor, floors, clamp) {
  const cfg = floorConfig(floors, floor);
  return clamp(x, cfg.minX, cfg.maxX - 1);
}

export function floorBounds(floor, floors, imageHeight, toFloorLL, latLngBounds) {
  const cfg = floorConfig(floors, floor);
  return latLngBounds(toFloorLL(floor, cfg.minX, 0), toFloorLL(floor, cfg.maxX, imageHeight));
}

export function floorViewportBounds(
  floor,
  floors,
  imageHeight,
  toFloorLL,
  latLngBounds,
  paddingX,
  paddingY
) {
  const cfg = floorConfig(floors, floor);
  return latLngBounds(
    toFloorLL(floor, cfg.minX - paddingX, -paddingY),
    toFloorLL(floor, cfg.maxX + paddingX, imageHeight + paddingY)
  );
}
```

- [ ] **Step 2: Import coordinate helpers in `js/app.js`**

Add this import after the DOM utility import:

```js
import {
  clampFloorX as clampFloorXValue,
  floorBounds as floorBoundsForConfig,
  floorConfig as floorConfigForConfig,
  floorForX as floorForXValue,
  floorLabelForX as floorLabelForXValue,
  floorLocalX as floorLocalXValue,
  floorViewportBounds as floorViewportBoundsForConfig,
  gameXYFromLatLng,
  globalFloorX as globalFloorXValue,
  mapLat as mapLatValue
} from './coordinates.js';
```

- [ ] **Step 3: Replace local coordinate helper bodies with wrappers**

In `js/app.js`, replace the current bodies of these functions with wrappers:

```js
  function mapLat(y) {
    return mapLatValue(y, IMG_H, INVERT_Y);
  }

  function toFloorLL(_floor, x, y) {
    return L.latLng(mapLat(y), x);
  }

  function toGameXY(ll) {
    return gameXYFromLatLng(ll, {
      imageWidth: IMG_W,
      imageHeight: IMG_H,
      invertY: INVERT_Y,
      clamp
    });
  }

  function floorConfig(floor) {
    return floorConfigForConfig(FLOORS, floor);
  }

  function floorForX(x) {
    return floorForXValue(x, FLOOR_WIDTH);
  }

  function floorLabelForX(x) {
    return floorLabelForXValue(x, FLOOR_WIDTH);
  }

  function floorLocalX(x, floor = floorForX(x)) {
    return floorLocalXValue(x, floor, FLOORS);
  }

  function globalFloorX(localX, floor) {
    return globalFloorXValue(localX, floor, FLOORS);
  }

  function clampFloorX(x, floor) {
    return clampFloorXValue(x, floor, FLOORS, clamp);
  }

  function floorBounds(floor) {
    return floorBoundsForConfig(floor, FLOORS, IMG_H, toFloorLL, L.latLngBounds);
  }

  function floorViewportBounds(floor) {
    return floorViewportBoundsForConfig(
      floor,
      FLOORS,
      IMG_H,
      toFloorLL,
      L.latLngBounds,
      FLOOR_VIEW_PADDING_X,
      FLOOR_VIEW_PADDING_Y
    );
  }
```

- [ ] **Step 4: Run coordinate checks**

Run:

```powershell
node --check js\coordinates.js
node --check js\app.js
node tests\search_layer_regression.mjs
python tools\run_map_update_checks.py
```

Expected:

- all Node commands exit `0`;
- map health check reports all `PASS`.

- [ ] **Step 5: Browser floor smoke check**

Reload `http://localhost:8010/` and verify:

- Overworld loads first;
- clicking Underground switches to the right half of the map;
- clicking Overworld switches back;
- search still focuses `Death Tyrant` on the correct floor.

- [ ] **Step 6: Commit Task 4**

Run:

```powershell
git add js\coordinates.js js\app.js
git commit -m "Extract coordinate helpers"
```

---

### Task 5: Extract Search Utilities

**Files:**

- Create: `js/search-utils.js`
- Modify: `js/app.js`

- [ ] **Step 1: Write the search utility module**

Create `js/search-utils.js` with exactly this content:

```js
export function normalizeName(name) {
  return (name || '').trim().toLowerCase();
}

export function escapeSearchRegex(term) {
  return String(term || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createSearchRegex(term, exact) {
  const q = (term || '').trim();
  if (!q) return null;
  const escaped = escapeSearchRegex(q);
  return new RegExp(exact ? `^${escaped}$` : escaped, 'i');
}

export function findSearchEntryByName(searchItems, name) {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  return searchItems.find(item => item.normalized === normalized) || null;
}

export function findSearchSuggestions({
  term,
  searchItems,
  currentFloor,
  floorForX,
  searchTypeOrder,
  limit
}) {
  const clean = normalizeName(term);
  if (!clean) return [];
  const matches = [];
  for (const entry of searchItems) {
    const idx = entry.normalized.indexOf(clean);
    if (idx === -1) continue;
    matches.push({ entry, idx });
  }
  matches.sort((a, b) => {
    if (a.idx !== b.idx) return a.idx - b.idx;
    const ta = Number.isFinite(searchTypeOrder[a.entry.type]) ? searchTypeOrder[a.entry.type] : 99;
    const tb = Number.isFinite(searchTypeOrder[b.entry.type]) ? searchTypeOrder[b.entry.type] : 99;
    if (ta !== tb) return ta - tb;
    const fa = Number.isFinite(a.entry.x) ? (floorForX(a.entry.x) === currentFloor ? 0 : 1) : 0;
    const fb = Number.isFinite(b.entry.x) ? (floorForX(b.entry.x) === currentFloor ? 0 : 1) : 0;
    if (fa !== fb) return fa - fb;
    return a.entry.name.localeCompare(b.entry.name);
  });
  return matches.slice(0, limit).map(match => match.entry);
}
```

- [ ] **Step 2: Import search utilities in `js/app.js`**

Add this import:

```js
import {
  createSearchRegex,
  findSearchEntryByName as findSearchEntryInList,
  findSearchSuggestions as findSearchSuggestionsInList,
  normalizeName
} from './search-utils.js';
```

- [ ] **Step 3: Replace local search normalization**

Replace:

```js
  const normalizeMonsterName = name => (name || '').trim().toLowerCase();
```

with:

```js
  const normalizeMonsterName = normalizeName;
```

- [ ] **Step 4: Replace local `findSearchSuggestions` body**

Replace the current `findSearchSuggestions(term)` function body with:

```js
  function findSearchSuggestions(term) {
    return findSearchSuggestionsInList({
      term,
      searchItems,
      currentFloor,
      floorForX,
      searchTypeOrder: SEARCH_TYPE_ORDER,
      limit: SEARCH_SUGGESTION_LIMIT
    });
  }
```

- [ ] **Step 5: Replace local `findSearchEntryByName` body**

Replace the current `findSearchEntryByName(name)` function body with:

```js
  function findSearchEntryByName(name) {
    return findSearchEntryInList(searchItems, name);
  }
```

- [ ] **Step 6: Replace inline regex creation in `runSearch`**

In `runSearch(exact = false)`, replace:

```js
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    currentSearchRegex = q
      ? new RegExp(exact ? `^${escaped}$` : escaped, 'i')
      : null;
```

with:

```js
    currentSearchRegex = createSearchRegex(q, exact);
```

- [ ] **Step 7: Run search checks**

Run:

```powershell
node --check js\search-utils.js
node --check js\app.js
node tests\search_layer_regression.mjs
```

Expected: all commands exit `0`.

- [ ] **Step 8: Browser search smoke check**

Reload `http://localhost:8010/` and verify:

- typing `Death Tyrant` shows one monster suggestion;
- selecting it turns on Monsters;
- Towns and POIs remain enabled and are not set to inline `display:none`;
- typing a known town name still shows a town suggestion and focuses the label.

- [ ] **Step 9: Commit Task 5**

Run:

```powershell
git add js\search-utils.js js\app.js
git commit -m "Extract search utilities"
```

---

### Task 6: Extract Monster And Zone Utility Helpers

**Files:**

- Create: `js/monster-utils.js`
- Modify: `js/app.js`

- [ ] **Step 1: Write the monster utility module**

Create `js/monster-utils.js` with exactly this content:

```js
export const ZONE_BOSS_LEVEL = 50;

export function optionValueFromLevel(value) {
  return Number.isFinite(value) ? String(value) : '';
}

export function parseMonsterLevelValue(raw) {
  if (raw === '' || raw === undefined || raw === null) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

export function monsterLevelFilterActive(min, max) {
  return Number.isFinite(min) || Number.isFinite(max);
}

export function passesMonsterLevelFilter(level, min, max) {
  if (!monsterLevelFilterActive(min, max)) return true;
  if (!Number.isFinite(level)) return false;
  if (Number.isFinite(min) && level < min) return false;
  if (Number.isFinite(max) && level > max) return false;
  return true;
}

export function sortedMonsterLevelValues(monsterLevels) {
  return monsterLevels
    ? Array.from(new Set(Array.from(monsterLevels.values()).filter(Number.isFinite))).sort((a, b) => a - b)
    : [];
}

export function enforceMonsterLevelRangeValues(min, max, whichChanged) {
  const hasMin = Number.isFinite(min);
  const hasMax = Number.isFinite(max);
  if (!hasMin || !hasMax || min <= max) {
    return { min, max };
  }
  if (whichChanged === 'min') {
    return { min, max: min };
  }
  return { min: max, max };
}

export function formatZoneLevels(levels) {
  if (!levels || typeof levels !== 'object') return '';
  const min = Number(levels.min);
  const max = Number(levels.max);
  if (Number.isFinite(min) && Number.isFinite(max)) {
    return min === max ? String(min) : `${min}-${max}`;
  }
  if (Number.isFinite(min)) return `${min}+`;
  if (Number.isFinite(max)) return `<=${max}`;
  return '';
}

export function zoneMaxLevel(levels) {
  if (!levels || typeof levels !== 'object') return null;
  const max = Number(levels.max);
  if (Number.isFinite(max)) return max;
  const min = Number(levels.min);
  return Number.isFinite(min) ? min : null;
}

export function zoneDifficultyStyle(level) {
  if (!Number.isFinite(level)) return {};
  if (level >= ZONE_BOSS_LEVEL) {
    return { bg: '#7f1d1d', border: '#ef4444', text: '#fee2e2', skull: true };
  }
  if (level >= 40) return { bg: '#4c1d95', border: '#a855f7', text: '#f3e8ff' };
  if (level >= 30) return { bg: '#7c2d12', border: '#fb923c', text: '#ffedd5' };
  if (level >= 20) return { bg: '#713f12', border: '#facc15', text: '#fef9c3' };
  if (level >= 10) return { bg: '#14532d', border: '#22c55e', text: '#dcfce7' };
  return { bg: '#1e293b', border: '#64748b', text: '#e2e8f0' };
}

export function monsterDifficultyColor(level) {
  if (!Number.isFinite(level)) return null;
  const difficulty = zoneDifficultyStyle(level);
  return difficulty.bg || difficulty.text || null;
}
```

- [ ] **Step 2: Compare existing zone helpers before replacing**

Open the existing `formatZoneLevels`, `zoneMaxLevel`, and `zoneDifficultyStyle` functions in `js/app.js`.

If any existing return values differ from the code above, update `js/monster-utils.js` to preserve the existing return values exactly before continuing.

- [ ] **Step 3: Import monster utilities in `js/app.js`**

Add this import:

```js
import {
  ZONE_BOSS_LEVEL,
  enforceMonsterLevelRangeValues,
  formatZoneLevels,
  monsterDifficultyColor,
  monsterLevelFilterActive as monsterLevelFilterActiveValue,
  optionValueFromLevel,
  parseMonsterLevelValue,
  passesMonsterLevelFilter as passesMonsterLevelFilterValue,
  sortedMonsterLevelValues,
  zoneDifficultyStyle,
  zoneMaxLevel
} from './monster-utils.js';
```

- [ ] **Step 4: Replace pure monster filter wrappers in `js/app.js`**

Replace the bodies of these functions in `js/app.js`:

```js
  function monsterLevelFilterActive() {
    return monsterLevelFilterActiveValue(monsterFilterMin, monsterFilterMax);
  }

  function passesMonsterLevelFilter(level) {
    return passesMonsterLevelFilterValue(level, monsterFilterMin, monsterFilterMax);
  }
```

- [ ] **Step 5: Use utility functions for level values**

Delete the local definitions of:

```js
  function optionValueFromLevel(value) {
    return Number.isFinite(value) ? String(value) : '';
  }

  function parseMonsterLevelValue(raw) {
    if (raw === '' || raw === undefined || raw === null) return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
  }
```

The imported functions have the same names and call sites should remain unchanged.

- [ ] **Step 6: Use utility function for sorted level options**

In `updateMonsterLevelSelectOptions()`, replace:

```js
    const levels = monsterLevels
      ? Array.from(new Set(Array.from(monsterLevels.values()).filter(Number.isFinite))).sort((a, b) => a - b)
      : [];
```

with:

```js
    const levels = sortedMonsterLevelValues(monsterLevels);
```

- [ ] **Step 7: Use utility function for range enforcement**

Replace the body of `enforceMonsterLevelRange(whichChanged)` with:

```js
  function enforceMonsterLevelRange(whichChanged) {
    const next = enforceMonsterLevelRangeValues(monsterFilterMin, monsterFilterMax, whichChanged);
    monsterFilterMin = next.min;
    monsterFilterMax = next.max;
    if (monsterLevelMinSelect) monsterLevelMinSelect.value = optionValueFromLevel(monsterFilterMin);
    if (monsterLevelMaxSelect) monsterLevelMaxSelect.value = optionValueFromLevel(monsterFilterMax);
  }
```

- [ ] **Step 8: Remove duplicated zone helper definitions from `js/app.js`**

Delete the full local function definitions named `formatZoneLevels`, `zoneMaxLevel`, `zoneDifficultyStyle`, and `monsterDifficultyColor` from `js/app.js`.

Keep `isBossMonster(name)` in `js/app.js` because it depends on the mutable `monsterLevels` map through `monsterLevel(name)`.

- [ ] **Step 9: Run monster utility checks**

Run:

```powershell
node --check js\monster-utils.js
node --check js\app.js
node tests\search_layer_regression.mjs
python tools\run_map_update_checks.py
```

Expected:

- all Node commands exit `0`;
- map health check reports all `PASS`.

- [ ] **Step 10: Browser monster filter smoke check**

Reload `http://localhost:8010/` and verify:

- monster level min/max dropdowns populate;
- setting a min level changes the filter status text;
- enabling Exclusive changes the button to `On`;
- clearing min/max returns the default filter status text;
- selecting `Death Tyrant` still renders matching monster chunk labels.

- [ ] **Step 11: Commit Task 6**

Run:

```powershell
git add js\monster-utils.js js\app.js
git commit -m "Extract monster utilities"
```

---

### Task 7: Update Documentation And Final Verification

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-04-codebase-cleanup-design.md`
- Modify: `docs/superpowers/plans/2026-07-04-codebase-cleanup-implementation.md`

- [ ] **Step 1: Update README verification commands**

If `README.md` names the old JS regression command, replace:

```powershell
node tests\search_layer_regression.js
```

with:

```powershell
node tests\search_layer_regression.mjs
```

Add this short note under the app entry point section if it is not already present:

```markdown
Frontend JavaScript uses native browser ES modules. There is no bundled build step; run the app through a static server rather than opening `index.html` directly from disk.
```

- [ ] **Step 2: Run full local verification**

Run:

```powershell
node --check js\app.js
node --check js\config.js
node --check js\coordinates.js
node --check js\dom-utils.js
node --check js\monster-utils.js
node --check js\search-utils.js
node tests\search_layer_regression.mjs
python -m unittest tests.test_run_map_update_checks
python tools\run_map_update_checks.py
```

Expected:

- every `node --check` exits `0`;
- `node tests\search_layer_regression.mjs` exits `0`;
- Python unittest reports `Ran 3 tests` and `OK`;
- map health check reports all `PASS`.

- [ ] **Step 3: Run browser verification**

Use a local static server:

```powershell
python -m http.server 8010
```

Validate these browser flows:

- app loads with the `Project Rogue Map` title;
- one map image layer is present;
- Overworld and Underground floor buttons switch floors;
- Towns, POIs, Portals, and Caves default to enabled;
- `Death Tyrant` search suggestion turns Monsters on and leaves Towns/POIs enabled without inline `display:none`;
- a town search can still focus a town label;
- browser console has no relevant warnings or errors.

- [ ] **Step 4: Check file size improvement**

Run:

```powershell
(Get-Content js\app.js).Count
Get-ChildItem js\*.js | Select-Object Name,Length
```

Expected:

- `js/app.js` line count is lower than before the cleanup;
- new modules exist and each has one clear responsibility.

- [ ] **Step 5: Commit Task 7**

Run:

```powershell
git add README.md docs\superpowers\specs\2026-07-04-codebase-cleanup-design.md docs\superpowers\plans\2026-07-04-codebase-cleanup-implementation.md
git commit -m "Document frontend module workflow"
```

- [ ] **Step 6: Push the cleanup branch**

If working on `main`, run:

```powershell
git push origin main
```

If working on a feature branch, run:

```powershell
git push origin HEAD
```

---

## Final Acceptance Checklist

- [ ] `index.html` loads `js/app.js` with `type="module"`.
- [ ] No build step or dependency install is required.
- [ ] `js/app.js` remains the Leaflet orchestration entrypoint.
- [ ] Config and pure helpers are in focused modules.
- [ ] Manual JSON overlay files are unchanged.
- [ ] Map image and map generation tools are unchanged.
- [ ] Search layer regression still passes.
- [ ] Map update health check still passes.
- [ ] Browser smoke checks pass on a local static server.
- [ ] Public deployment still serves the app after push.
