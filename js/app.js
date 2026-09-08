/* global L */  // hint for editors with TS/JS type checking
// If VS Code still flags DOM/Leaflet types, you can uncomment the next line:
// // @ts-nocheck

import {
  CHUNK_SIZE,
  DATA,
  FLOOR_VIEW_PADDING_X,
  FLOOR_VIEW_PADDING_Y,
  FLOOR_WIDTH,
  FLOORS,
  IMG_PATH,
  INVERT_Y,
  LOCALES_IMG_PATH,
  MATCH_ZINDEX_OFFSET,
  MIN_CHUNK_SCREEN_PX,
  MONSTER_FILTER_HINT_DEFAULT,
  MONSTER_FILTER_HINT_NEED_RANGE,
  MONSTER_FILTER_HINT_UNAVAILABLE,
  MONSTER_OVERVIEW_MAX_SPAN,
  MONSTER_OVERVIEW_TARGET_PX,
  SAFE_ZONE_IMG_PATH,
  SEARCH_CLUSTER_RADIUS,
  SEARCH_LABEL_MIN_PX,
  SEARCH_SUGGESTION_LIMIT,
  SEARCH_TYPE_ORDER,
  WARFRONT_IMG_PATH,
  ZOOM_OUT_EXTRA
} from './config.js';
import { clamp, debounce, escHtml, readCssVar } from './dom-utils.js';
import { createMapTools } from './map-tools.js';
import { createChunkLabelLayoutCache } from './chunk-label-layout-cache.js';
import { monsterViewportBuffer, monsterViewportNeedsRefresh } from './monster-viewport-state.js';
import {
  clampFloorX as clampFloorXValue,
  floorBounds as floorBoundsForConfig,
  floorConfig as floorConfigForConfig,
  floorForX as floorForXValue,
  floorLabelForX as floorLabelForXValue,
  floorViewportBounds as floorViewportBoundsForConfig,
  gameXYFromLatLng,
  mapLat as mapLatValue
} from './coordinates.js';
import {
  createSearchRegex,
  findSearchEntryByName as findSearchEntryInList,
  findSearchSuggestions as findSearchSuggestionsInList,
  normalizeName
} from './search-utils.js';
import { buildSearchIndex as buildSearchItems } from './search-index.js';
import {
  chunkMonsterNames,
  isBossMonster as isBossMonsterName,
  selectTopMonster as selectTopChunkMonster
} from './chunk-label-state.js';
import {
  buildMonsterOverviewGroups,
  monsterOverviewGroupSpan
} from './monster-overview-state.js';
import {
  bestSearchClusterCenter as bestSearchClusterCenterValue,
  searchEntryFocusTarget,
  searchLabelZoom as searchLabelZoomValue,
  searchTypeForRun
} from './search-focus-state.js';
import {
  labelLayerKeyForSearchType,
  searchLabelMarkerState
} from './layer-state.js';
import {
  monsterFilterStatusText,
  normalizeMonsterFilterExclusive,
  reconcileMonsterFilterState
} from './monster-filter-state.js';
import {
  coordinateTargetFromUrlSearch,
  normalizeCoordinateTarget as normalizeCoordinateTargetValue,
  searchTermFromUrlSearch,
  urlWithSearchTerm
} from './url-state.js';
import {
  normalizeCaveList,
  normalizeCrimList,
  normalizeEncounterIndex,
  normalizeLocaleData,
  normalizeMonsterLevels,
  normalizePoiList,
  normalizePortalList,
  normalizeWarfrontData,
  normalizeZoneList
} from './data-normalization.js';
import {
  isPortalLabelItem,
  portalEndpoints,
  splitPortalItems
} from './portal-state.js';
import {
  caveEndpoints,
  transportFocusZoom
} from './transport-state.js';
import {
  enforceMonsterLevelRangeValues,
  formatZoneLevels,
  monsterDifficultyColor,
  monsterLevelFilterActive as monsterLevelFilterActiveValue,
  optionValueFromLevel,
  parseMonsterLevelValue,
  sortedMonsterLevelValues,
  zoneDifficultyStyle,
  zoneMaxLevel
} from './monster-utils.js';

(() => {

  // -------- Map & panes --------
  const map = L.map('map', {
    crs: L.CRS.Simple,
    zoomControl: true,
    zoomSnap: 1,
    zoomDelta: 1,
    zoomAnimation: false,
    fadeAnimation: false,
    inertia: true,
    preferCanvas: true,
    maxBoundsViscosity: 1
  });

  map.createPane('locales').style.zIndex         = 400;
  map.getPane('locales').style.pointerEvents     = 'none';
  map.createPane('warfronts').style.zIndex       = 405;
  map.getPane('warfronts').style.pointerEvents   = 'none';
  map.createPane('safe-zones').style.zIndex      = 410;
  map.getPane('safe-zones').style.pointerEvents  = 'none';
  map.createPane('warfront-labels').style.zIndex = 620;
  map.getPane('warfront-labels').style.pointerEvents = 'none';
  map.createPane('locale-labels').style.zIndex   = 622;
  map.getPane('locale-labels').style.pointerEvents = 'none';
  map.createPane('routes').style.zIndex         = 640;
  map.createPane('zones').style.zIndex          = 642;
  map.createPane('zones-labels').style.zIndex   = 643;
  map.createPane('chunk').style.zIndex          = 648;  // under portals
  map.createPane('crim').style.zIndex           = 649;
  map.createPane('labels-portals').style.zIndex = 652;
  map.createPane('portalLines').style.zIndex    = 653;  // interactive transport nodes (portals/caves)
  map.createPane('labels-places').style.zIndex = 655;
  map.createPane('elite').style.zIndex          = 670;
  map.createPane('deep-link').style.zIndex      = 680;
  map.createPane('floor-mask').style.zIndex     = 900;
  map.getPane('floor-mask').style.pointerEvents = 'none';

  const ICONS = {
    portal: L.icon({
      iconUrl: './img/Portal.png',
      iconSize: [32, 32],
      iconAnchor: [16, 16],
      className: 'transport-icon portal-icon'
    }),
    cave: L.icon({
      iconUrl: './img/Cave.png',
      iconSize: [32, 32],
      iconAnchor: [16, 16],
      className: 'transport-icon cave-icon'
    }),
    crim: L.icon({
      iconUrl: './img/Crim_Spawn.png',
      iconSize: [32, 32],
      iconAnchor: [16, 16],
      className: 'transport-icon crim-icon'
    })
  };

  // -------- Layers --------
  const portalsLblFG  = L.layerGroup();            // OFF at load
  const portalLinesFG = L.featureGroup();          // OFF at load
  const routes        = L.featureGroup().addTo(map);
  const respawnFG     = L.featureGroup().addTo(map);
  const chunkFG       = L.featureGroup();          // OFF at load (Monsters)
  const cavesFG       = L.featureGroup();          // OFF at load
  const crimFG        = L.featureGroup();          // OFF at load
  const poisFG        = L.layerGroup();            // OFF at load
  const zonesFG       = L.featureGroup();          // OFF at load
  const localeLabelsFG = L.layerGroup();           // ON after locale data loads
  const warfrontLabelsFG = L.layerGroup();         // OFF at load
  const eliteFG       = L.featureGroup().addTo(map);
  const deepLinkFG    = L.featureGroup().addTo(map);
  const localeSearchFG = L.featureGroup().addTo(map);
  const floorMaskFG   = L.featureGroup().addTo(map);
  let safeZonesOverlay = null;
  let localeOverlay = null;
  let warfrontOverlay = null;
  let coordinateUrlMarker = null;

  // -------- UI hooks --------
  const $ = sel => document.querySelector(sel);
  const getZoneColor = () => readCssVar('--zone-color') || '#f59e0b';
  const getCrimColor = () => readCssVar('--crim-color') || '#fb7185';

  // Pills (default: Locales ON; all other map layers OFF)
  const pillMonsters = $('#pillMonsters');
  const pillPortals  = $('#pillPortals');
  const pillCaves    = $('#pillCaves');
  const pillZones    = $('#pillZones');
  const pillLocales  = $('#pillLocales');
  const pillSafeZones = $('#pillSafeZones');
  const pillWarfronts = $('#pillWarfronts');
  const pillPois     = $('#pillPois');
  const pillCrim     = $('#pillCrim');
  const btnFloorOverworld = $('#btnFloorOverworld');
  const btnFloorUnderground = $('#btnFloorUnderground');
  const searchInput  = $('#search');
  const searchSuggestions = $('#searchSuggestions');
  const monsterLevelMinSelect = $('#monsterLevelMin');
  const monsterLevelMaxSelect = $('#monsterLevelMax');
  const monsterLevelExclusiveBtn = $('#monsterLevelExclusive');
  const monsterLevelFilterStatus = $('#monsterLevelFilterStatus');
  const panel        = $('#panel');
  const btnCollapse  = $('#btnCollapse');
  const codexLogoImg = $('#codexLogo');

  function setPill(btn, on) { if (btn) { btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', on ? 'true' : 'false'); } }
  function isOn(btn)       { return !!btn && btn.classList.contains('on'); }

  function readSearchFromUrl() {
    if (typeof window === 'undefined') return '';
    return searchTermFromUrlSearch(window.location.search);
  }

  function persistSearchToUrl(term) {
    if (typeof window === 'undefined' || !window.history?.replaceState) return;
    const next = urlWithSearchTerm(window.location, term);
    window.history.replaceState(null, '', next);
  }

  function readCoordinateTargetFromUrl() {
    if (typeof window === 'undefined') return null;
    return coordinateTargetFromUrlSearch(window.location.search);
  }

  function normalizeCoordinateTarget(target) {
    return normalizeCoordinateTargetValue({
      target,
      imageWidth: IMG_W,
      imageHeight: IMG_H,
      clamp,
      floorForX,
      clampFloorX
    });
  }

  function nameIcon(innerHtml)  {
    return L.divIcon({
      className: 'lbl',
      html: `<div class="lbl-inner">${innerHtml}</div>`,
      iconSize: null
    });
  }

  function coordinateLinkIcon(label = '') {
    const markerLabel = label
      ? `<span class="coord-link-marker-label">${escHtml(label)}</span>`
      : '';
    return L.divIcon({
      className: 'coord-link-marker',
      html: `
        <div class="coord-link-marker-content">
          <div class="coord-link-marker-inner" aria-hidden="true">X</div>
          ${markerLabel}
        </div>
      `,
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });
  }

  function showCoordinateTargetMarker(x, y, label = '') {
    const latlng = toLL(x, y);
    if (!coordinateUrlMarker) {
      coordinateUrlMarker = L.marker(latlng, {
        pane: 'deep-link',
        interactive: false,
        keyboard: false,
        icon: coordinateLinkIcon(label)
      }).addTo(deepLinkFG);
    } else {
      coordinateUrlMarker.setLatLng(latlng);
      coordinateUrlMarker.setIcon(coordinateLinkIcon(label));
    }
  }

  function focusCoordinateTarget(target, opts = {}) {
    const point = normalizeCoordinateTarget(target);
    if (!point) return null;
    showCoordinateTargetMarker(point.x, point.y, point.label);
    const focused = focusWorldPoint(point.x, point.y, opts);
    return focused ? point : null;
  }

  function setPanelCollapsed(collapsed) {
    if (!panel) return;
    panel.classList.toggle('collapsed', collapsed);
    if (btnCollapse) {
      const nextLabel = collapsed ? 'Expand panel' : 'Collapse panel';
      btnCollapse.textContent = collapsed ? '>' : '<';
      btnCollapse.setAttribute('aria-label', nextLabel);
      btnCollapse.setAttribute('title', nextLabel);
      btnCollapse.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
  }
  btnCollapse?.addEventListener('click', () => {
    const isCollapsed = panel?.classList.contains('collapsed');
    setPanelCollapsed(!isCollapsed);
  });
  setPanelCollapsed(false);

  let IMG_W = 0, IMG_H = 0;
  let floorMinZoom = null;
  let currentFloor = 'overworld';
  const floorViews = new Map();
  let mapTools = null;
  // lat = y, lng = x for CRS.Simple; we’ll set the final mapping after image load (needs IMG_H for Y flip)
  let toLL = (x, y) => L.latLng(y, x);

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

  function renderFloorMask() {
    floorMaskFG.clearLayers();
    if (!IMG_W || !IMG_H) return;
    const hiddenBounds = currentFloor === 'overworld'
      ? L.latLngBounds(toFloorLL('underground', FLOOR_WIDTH, 0), toFloorLL('underground', IMG_W, IMG_H))
      : L.latLngBounds(toFloorLL('overworld', 0, 0), toFloorLL('overworld', FLOOR_WIDTH, IMG_H));
    L.rectangle(hiddenBounds, {
      pane: 'floor-mask',
      stroke: false,
      fill: true,
      fillColor: '#000',
      fillOpacity: 1,
      interactive: false,
      bubblingMouseEvents: false
    }).addTo(floorMaskFG);
  }

  function setFloorButtonState(btn, active) {
    if (!btn) return;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  function syncFloorButtons() {
    setFloorButtonState(btnFloorOverworld, currentFloor === 'overworld');
    setFloorButtonState(btnFloorUnderground, currentFloor === 'underground');
  }

  function currentFloorBounds() {
    return floorBounds(currentFloor);
  }

  function refreshFloorViewport() {
    if (!IMG_W || !IMG_H) return;
    if (Number.isFinite(floorMinZoom)) {
      map.setMinZoom(floorMinZoom);
    }
    const bounds = floorViewportBounds(currentFloor);
    map.setMaxBounds(bounds);
    renderFloorMask();
  }

  function switchFloor(nextFloor, { x = null, y = null, zoom = null } = {}) {
    const targetFloor = floorConfig(nextFloor).key;
    const hasDestination = Number.isFinite(x) || Number.isFinite(y) || Number.isFinite(zoom);
    if (targetFloor === currentFloor && !hasDestination) {
      syncFloorButtons();
      return;
    }

    if (!IMG_W || !IMG_H) {
      currentFloor = targetFloor;
      syncFloorButtons();
      return;
    }

    // Stop the outgoing camera before saving it; keep fractional coordinates
    // and the padded edge position intact when returning to this floor.
    map.stop();
    monsterZooming = false;
    const center = map.getCenter();
    floorViews.set(currentFloor, { center: L.latLng(center.lat, center.lng), zoom: map.getZoom() });
    const savedView = floorViews.get(targetFloor);
    currentFloor = targetFloor;
    syncFloorButtons();
    map.setMaxBounds(null);

    // Explicit links, searches, and transport destinations always take priority,
    // including the first visit. Floor buttons restore a view or show an overview.
    if (hasDestination) {
      const fallbackCenter = savedView?.center || floorBounds(targetFloor).getCenter();
      const targetCenter = L.latLng(
        Number.isFinite(y) ? mapLat(clamp(y, 0, IMG_H)) : fallbackCenter.lat,
        Number.isFinite(x) ? clampFloorX(x, targetFloor) : fallbackCenter.lng
      );
      const targetZoom = clamp(Number.isFinite(zoom) ? zoom : map.getZoom(), map.getMinZoom(), map.getMaxZoom());
      map.setView(targetCenter, targetZoom, { animate: false });
    } else if (savedView) {
      map.setView(savedView.center, clamp(savedView.zoom, map.getMinZoom(), map.getMaxZoom()), { animate: false });
    } else {
      map.fitBounds(floorBounds(targetFloor), { animate: false });
    }

    // Change floors atomically: no cross-map flight or delayed zoom bounce that
    // could overwrite a newer user action. Refresh labels even at the same zoom.
    refreshFloorViewport();
    mapTools?.onFloorChange();

    refreshChunkLayer();
    rerunCollision();
  }

  function focusWorldPoint(x, y, opts = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !IMG_W || !IMG_H) return false;
    const {
      animate = true,
      duration = 0.8,
      zoom = null,
      zoomBoost = 2
    } = opts;
    const targetFloor = floorForX(x);
    const minZoom = map.getMinZoom();
    const defaultZoom = Number.isFinite(minZoom) ? minZoom + zoomBoost : map.getZoom();
    const desiredZoom = Number.isFinite(zoom) ? zoom : Math.max(map.getZoom(), defaultZoom);
    const maxZoom = map.getMaxZoom();
    const targetZoom = Number.isFinite(maxZoom) ? Math.min(desiredZoom, maxZoom) : desiredZoom;

    if (currentFloor !== targetFloor) {
      switchFloor(targetFloor, { x, y, zoom: targetZoom });
      return true;
    }

    const latlng = toLL(x, y);
    if (animate) {
      map.flyTo(latlng, targetZoom, { animate: true, duration });
    } else {
      map.setView(latlng, targetZoom, { animate: false });
    }
    return true;
  }

  btnFloorOverworld?.addEventListener('click', () => switchFloor('overworld'));
  btnFloorUnderground?.addEventListener('click', () => switchFloor('underground'));
  syncFloorButtons();

  const paneByKind = {
    poi:  'labels-places',
    portal: 'labels-portals'
  };

  function makeLabel(x, y, name, kind) {
    return L.marker(toLL(x, y), {
      icon: nameIcon(`<span class="n ${kind}">${escHtml(name)}</span>`),
      pane: paneByKind[kind] || 'labels-portals',
      bubblingMouseEvents: false
    });
  }

  function randomArrayItem(arr) {
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  const CODEX_LOGOS = ['./img/codex-logo-1.png', './img/codex-logo-2.png'];

  if (codexLogoImg) {
    const pick = randomArrayItem(CODEX_LOGOS) || CODEX_LOGOS[0];
    codexLogoImg.src = pick;
  }

  function initialViewTargets() {
    const combined = [
      ...(Array.isArray(window.__localeSearchCache) ? window.__localeSearchCache : []),
      ...(Array.isArray(window.__poiDataCache) ? window.__poiDataCache : [])
    ].filter(it => Number.isFinite(it?.x) && Number.isFinite(it?.y) && floorForX(it.x) === currentFloor);
    return combined;
  }

  // -------- Monsters (chunk labels) via encounters.json only --------
  const chunkTiles = new Map();   // key "cx,cy" -> L.Marker
  const overviewTiles = new Map(); // key "span:cx,cy" -> L.Marker
  let monsterRenderedView = null;
  let lastMonsterPanRefresh = -Infinity;
  let monsterPanTimer = null;
  let monsterZooming = false;
  let encountersIndex = null;     // Map<"cx,cy", string[]>
  let monsterLevels = null;       // Map<monster name, level>
  let monsterLevelValues = [];    // Unique sorted level list for filter UI
  let monsterFilterMin = null;
  let monsterFilterMax = null;
  let monsterFilterExclusive = false;
  let currentSearchRegex = null;
  let currentSearchType = null;
  let currentSearchEntry = null;
  let searchItems = [];           // [{ name, normalized, level, type, x?, y? }]

  function namesForChunk(cx, cy) {
    return chunkMonsterNames({
      encountersIndex,
      cx,
      cy,
      monsterLevelForName: monsterLevel,
      min: monsterFilterMin,
      max: monsterFilterMax,
      exclusive: monsterFilterExclusive,
      searchRegex: currentSearchRegex
    });
  }

  function monsterLevel(name) {
    if (!monsterLevels) return null;
    const lvl = monsterLevels.get(normalizeName(name));
    return Number.isFinite(lvl) ? lvl : null;
  }

  function buildSearchIndex() {
    searchItems = buildSearchItems({
      encountersIndex,
      locales: Array.isArray(window.__localeSearchCache) ? window.__localeSearchCache : [],
      pois: Array.isArray(window.__poiDataCache) ? window.__poiDataCache : [],
      monsterLevelForName: monsterLevel
    });
  }

  function monsterLevelFilterActive() {
    return monsterLevelFilterActiveValue(monsterFilterMin, monsterFilterMax);
  }

  function syncMonsterLevelExclusiveBtn() {
    if (!monsterLevelExclusiveBtn) return;
    monsterLevelExclusiveBtn.classList.toggle('on', monsterFilterExclusive);
    monsterLevelExclusiveBtn.setAttribute('aria-pressed', monsterFilterExclusive ? 'true' : 'false');
    monsterLevelExclusiveBtn.textContent = monsterFilterExclusive ? 'On' : 'Off';
  }

  function setMonsterLevelExclusive(next) {
    const normalized = normalizeMonsterFilterExclusive(next, monsterLevelValues);
    if (monsterFilterExclusive === normalized) {
      syncMonsterLevelExclusiveBtn();
      updateMonsterLevelFilterStatus();
      return;
    }
    monsterFilterExclusive = normalized;
    syncMonsterLevelExclusiveBtn();
    updateMonsterLevelFilterStatus();
    if (isOn(pillMonsters)) refreshChunkLayer();
  }

  function updateMonsterLevelSelectOptions() {
    const levels = sortedMonsterLevelValues(monsterLevels);
    monsterLevelValues = levels;
    const previousExclusive = monsterFilterExclusive;
    const nextState = reconcileMonsterFilterState({
      levelValues: monsterLevelValues,
      min: monsterFilterMin,
      max: monsterFilterMax,
      exclusive: monsterFilterExclusive
    });
    monsterFilterMin = nextState.min;
    monsterFilterMax = nextState.max;
    monsterFilterExclusive = nextState.exclusive;
    const html = ['<option value="">Any</option>', ...monsterLevelValues.map(lvl => `<option value="${lvl}">${lvl}</option>`)].join('');
    if (monsterLevelMinSelect) {
      monsterLevelMinSelect.innerHTML = html;
      monsterLevelMinSelect.disabled = monsterLevelValues.length === 0;
      monsterLevelMinSelect.value = optionValueFromLevel(monsterFilterMin);
    }
    if (monsterLevelMaxSelect) {
      monsterLevelMaxSelect.innerHTML = html;
      monsterLevelMaxSelect.disabled = monsterLevelValues.length === 0;
      monsterLevelMaxSelect.value = optionValueFromLevel(monsterFilterMax);
    }
    if (monsterLevelExclusiveBtn) {
      monsterLevelExclusiveBtn.disabled = monsterLevelValues.length === 0;
    }
    syncMonsterLevelExclusiveBtn();
    updateMonsterLevelFilterStatus();
    if (previousExclusive !== monsterFilterExclusive && isOn(pillMonsters)) refreshChunkLayer();
  }

  function updateMonsterLevelFilterStatus() {
    if (!monsterLevelFilterStatus) return;
    monsterLevelFilterStatus.textContent = monsterFilterStatusText({
      levelValues: monsterLevelValues,
      min: monsterFilterMin,
      max: monsterFilterMax,
      exclusive: monsterFilterExclusive,
      hints: {
        default: MONSTER_FILTER_HINT_DEFAULT,
        unavailable: MONSTER_FILTER_HINT_UNAVAILABLE,
        needRange: MONSTER_FILTER_HINT_NEED_RANGE
      }
    });
  }

  function enforceMonsterLevelRange(whichChanged) {
    const next = enforceMonsterLevelRangeValues(monsterFilterMin, monsterFilterMax, whichChanged);
    monsterFilterMin = next.min;
    monsterFilterMax = next.max;
    if (monsterLevelMinSelect) monsterLevelMinSelect.value = optionValueFromLevel(monsterFilterMin);
    if (monsterLevelMaxSelect) monsterLevelMaxSelect.value = optionValueFromLevel(monsterFilterMax);
  }

  function handleMonsterLevelSelectChange(which) {
    if (which === 'min') {
      monsterFilterMin = parseMonsterLevelValue(monsterLevelMinSelect?.value);
    } else {
      monsterFilterMax = parseMonsterLevelValue(monsterLevelMaxSelect?.value);
    }
    enforceMonsterLevelRange(which);
    updateMonsterLevelFilterStatus();
    if (isOn(pillMonsters)) refreshChunkLayer();
  }

  function chunkBounds(cx, cy) {
    const x0 = cx * CHUNK_SIZE, y0 = cy * CHUNK_SIZE;
    return L.latLngBounds(toLL(x0, y0), toLL(x0 + CHUNK_SIZE, y0 + CHUNK_SIZE));
  }

  function overviewBounds(group) {
    const x0 = group.chunkX * CHUNK_SIZE;
    const y0 = group.chunkY * CHUNK_SIZE;
    const size = group.span * CHUNK_SIZE;
    return L.latLngBounds(toLL(x0, y0), toLL(x0 + size, y0 + size));
  }

  function clearMarkerMap(markers) {
    for (const marker of markers.values()) chunkFG.removeLayer(marker);
    markers.clear();
  }

  function clearMonsterMarkers() {
    monsterRenderedView = null;
    clearTimeout(monsterPanTimer);
    monsterPanTimer = null;
    clearMarkerMap(chunkTiles);
    clearMarkerMap(overviewTiles);
  }

  const chunkLabelLayouts = createChunkLabelLayoutCache();

  function invalidateChunkLabelLayouts() {
    chunkLabelLayouts.clear();
    refreshChunkLayer();
  }

  // A font swap can change the fit even if the names and cell size are unchanged.
  document.fonts?.addEventListener('loadingdone', invalidateChunkLabelLayouts);
  document.fonts?.addEventListener('loadingerror', invalidateChunkLabelLayouts);

  function applyInner(el, w, h, names) {
    const inner = el.querySelector('.chunk-label-inner'); if (!inner) return;
    // Measurements made with a temporary fallback font must not enter the cache.
    const canCache = document.fonts?.status !== 'loading';
    const cached = canCache && chunkLabelLayouts.get(w, h, names);
    if (cached) {
      inner.classList.toggle('compact', cached.compact);
      inner.innerHTML = cached.html;
      inner.style.fontSize = cached.fontSize;
      inner.style.lineHeight = '1.05';
      return;
    }
    inner.classList.remove('compact');
    inner.innerHTML = names.map(n => {
      const boss = isBossMonsterName(n, monsterLevel);
      const lvl = monsterLevel(n);
      const tint = !boss ? monsterDifficultyColor(lvl) : null;
      const cls = boss ? 'line boss-monster' : 'line';
      const styleAttr = tint ? ` style="color:${tint}"` : '';
      return `<div class="${cls}"${styleAttr}>${escHtml(n)}</div>`;
    }).join('');
    // shrink-to-fit
    const padW = Math.max(0, w - 4), padH = Math.max(0, h - 4);
    let fs = 16;
    for (; fs >= 8; fs--) {
      inner.style.fontSize = fs + 'px';
      inner.style.lineHeight = '1.05';
      if (inner.scrollWidth <= padW && inner.scrollHeight <= padH) break;
    }
    if (fs < 8) {
      inner.classList.add('compact');
      const top = selectTopChunkMonster(names, monsterLevel);
      if (top && Number.isFinite(top.level)) {
        const cls = isBossMonsterName(top.name, monsterLevel) ? 'chunk-top-level boss-monster' : 'chunk-top-level';
        const difficulty = zoneDifficultyStyle(top.level);
        const styleBits = [];
        if (difficulty?.bg) styleBits.push(`background:${difficulty.bg}`);
        if (difficulty?.border) styleBits.push(`border-color:${difficulty.border}`);
        if (difficulty?.text) styleBits.push(`color:${difficulty.text}`);
        const styleAttr = styleBits.length ? ` style="${styleBits.join(';')}"` : '';
        inner.innerHTML = `<span class="${cls}"${styleAttr}>${escHtml(top.level)}</span>`;
      } else {
        inner.innerHTML = `<span class="chunk-count">${names.length}</span>`;
      }
    }
    if (canCache) {
      chunkLabelLayouts.set(w, h, names, {
        html: inner.innerHTML,
        fontSize: inner.style.fontSize,
        compact: inner.classList.contains('compact')
      });
    }
  }

  function fitChunkLabel(bounds, names, marker) {
    const tl = map.latLngToLayerPoint(bounds.getNorthWest());
    const br = map.latLngToLayerPoint(bounds.getSouthEast());
    const w = Math.max(8, Math.round(br.x - tl.x));
    const h = Math.max(8, Math.round(br.y - tl.y));

    const key = names.join('|');
    if (marker._lastW === w && marker._lastH === h && marker._lastHash === key
      && marker._layoutRevision === chunkLabelLayouts.revision) return;
    marker._lastW = w; marker._lastH = h; marker._lastHash = key;
    marker._layoutRevision = chunkLabelLayouts.revision;

    const html = `<div class="chunk-label"><div class="chunk-label-inner"></div></div>`;
    const icon = L.divIcon({ className: 'chunk-icon', html, iconSize: [w, h], iconAnchor: [w / 2, h / 2] });
    marker.setIcon(icon);

    // If the DOM element is not yet mounted, schedule a one-frame retry.
    const elNow = marker.getElement();
    if (elNow) {
      applyInner(elNow, w, h, names);
    } else {
      requestAnimationFrame(() => {
        const elLater = marker.getElement();
        if (elLater) applyInner(elLater, w, h, names);
      });
    }
  }

  function chunkScreenSize() {
    const p0 = map.latLngToLayerPoint(toLL(0, 0));
    const p1 = map.latLngToLayerPoint(toLL(CHUNK_SIZE, CHUNK_SIZE));
    return [Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y)];
  }

  function overviewTooltipHtml(group) {
    const countLabel = group.occupiedChunks === 1 ? '1 encounter tile' : `${group.occupiedChunks} encounter tiles`;
    const rows = group.topMonsters.slice(0, 6).map(monster => {
      const level = Number.isFinite(monster.level) ? `Lv ${monster.level}` : 'Lv ?';
      const frequency = monster.chunkCount === 1 ? '1 tile' : `${monster.chunkCount} tiles`;
      return `<div class="monster-overview-tooltip-row"><span>${escHtml(monster.name)}</span><span>${level} · ${frequency}</span></div>`;
    }).join('');
    const remainder = Math.max(0, group.distinctMonsters - 6);
    const more = remainder ? `<div class="monster-overview-tooltip-more">+${remainder} more types</div>` : '';
    return `<div class="monster-overview-tooltip-content"><strong>${escHtml(group.levelLabel)}</strong><span>${countLabel} · ${group.distinctMonsters} monster types</span>${rows}${more}</div>`;
  }

  function overviewLabelHtml(group) {
    const dominant = group.topMonsters[0];
    const extra = Math.max(0, group.distinctMonsters - 1);
    const tier = group.span >= 32 ? 'far' : group.span >= 8 ? 'mid' : 'near';
    const primary = tier === 'far' ? group.levelLabel : dominant?.name || group.levelLabel;
    const secondary = tier === 'far'
      ? `${group.distinctMonsters} ${group.distinctMonsters === 1 ? 'type' : 'types'}`
      : `${group.levelLabel}${extra ? ` · +${extra}` : ''}`;
    const difficulty = zoneDifficultyStyle(group.maxLevel);
    const centerX = clamp((group.centerChunkX - group.chunkX) / group.span, 0.2, 0.8) * 100;
    const centerY = clamp((group.centerChunkY - group.chunkY) / group.span, 0.2, 0.8) * 100;
    const style = [
      `--monster-overview-accent:${difficulty.border}`,
      `--monster-overview-surface:${difficulty.bg}`,
      `--monster-overview-x:${centerX}%`,
      `--monster-overview-y:${centerY}%`
    ].join(';');
    const bossClass = difficulty.skull ? ' boss' : '';
    return `<div class="monster-overview-cell tier-${tier}${bossClass}" style="${style}"><div class="monster-overview-badge"><span class="monster-overview-primary">${escHtml(primary)}</span><span class="monster-overview-secondary">${escHtml(secondary)}</span></div></div>`;
  }

  function zoomIntoMonsterOverview(marker) {
    const target = marker._overviewGroup;
    if (!target) return;
    const maxZoom = map.getMaxZoom();
    const nextZoom = Math.min(map.getZoom() + 1, Number.isFinite(maxZoom) ? maxZoom : map.getZoom() + 1);
    map.setView(toLL(target.centerChunkX * CHUNK_SIZE, target.centerChunkY * CHUNK_SIZE), nextZoom);
  }

  function wireOverviewBadge(marker) {
    const wire = () => {
      const badge = marker.getElement()?.querySelector('.monster-overview-badge');
      if (!badge || badge.dataset.zoomWired === 'true') return;
      badge.dataset.zoomWired = 'true';
      badge.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        zoomIntoMonsterOverview(marker);
      });
    };
    wire();
    requestAnimationFrame(wire);
  }

  function fitOverviewLabel(bounds, group, marker) {
    const tl = map.latLngToLayerPoint(bounds.getNorthWest());
    const br = map.latLngToLayerPoint(bounds.getSouthEast());
    const w = Math.max(40, Math.round(Math.abs(br.x - tl.x)));
    const h = Math.max(40, Math.round(Math.abs(br.y - tl.y)));
    const hash = `${group.levelLabel}|${group.occupiedChunks}|${group.topMonsters.map(monster => `${monster.name}:${monster.chunkCount}`).join('|')}`;
    if (marker._lastW === w && marker._lastH === h && marker._lastHash === hash) return;
    marker._lastW = w;
    marker._lastH = h;
    marker._lastHash = hash;
    marker.setIcon(L.divIcon({
      className: 'monster-overview-icon',
      html: overviewLabelHtml(group),
      iconSize: [w, h],
      iconAnchor: [w / 2, h / 2]
    }));
    wireOverviewBadge(marker);
    const tooltip = overviewTooltipHtml(group);
    if (marker.getTooltip()) marker.setTooltipContent(tooltip);
    else marker.bindTooltip(tooltip, { direction: 'top', offset: [0, -12], opacity: 1, className: 'monster-overview-tooltip' });
  }

  function renderMonsterOverview({ cx0, cx1, cy0, cy1, span }) {
    clearMarkerMap(chunkTiles);
    const groups = buildMonsterOverviewGroups({
      cx0,
      cx1,
      cy0,
      cy1,
      span,
      namesForChunk,
      monsterLevelForName: monsterLevel
    });
    const keep = new Set();

    for (const group of groups) {
      keep.add(group.key);
      const bounds = overviewBounds(group);
      let marker = overviewTiles.get(group.key);
      if (!marker) {
        marker = L.marker(bounds.getCenter(), {
          pane: 'chunk',
          interactive: true,
          keyboard: true,
          bubblingMouseEvents: false,
          title: 'Zoom in to inspect this encounter area'
        }).addTo(chunkFG);
        marker.on('click', () => zoomIntoMonsterOverview(marker));
        overviewTiles.set(group.key, marker);
      }
      marker._overviewGroup = group;
      fitOverviewLabel(bounds, group, marker);
    }

    for (const [key, marker] of overviewTiles) {
      if (!keep.has(key)) {
        chunkFG.removeLayer(marker);
        overviewTiles.delete(key);
      }
    }
  }

  function chunkScreenSizeAtZoom(z) {
    const p0 = map.project(toLL(0, 0), z);
    const p1 = map.project(toLL(CHUNK_SIZE, CHUNK_SIZE), z);
    return [Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y)];
  }

  function requiredChunkPxForSearchTerm(term) {
    const base = Math.max(MIN_CHUNK_SCREEN_PX, SEARCH_LABEL_MIN_PX);
    const clean = (term || '').trim();
    if (!clean) return base;
    // Rough width estimate: gently scale with length, small cap to avoid over-zooming.
    const extra = Math.min(20, Math.max(0, (clean.length - 5) * 2));
    return base + extra;
  }

  function ensureMonstersZoom() {
    if (!IMG_W || !IMG_H) return false;
    if (currentSearchRegex) return false; // search mode already forces labels visible at any zoom

    const [cw, ch] = chunkScreenSize();
    if (cw >= MIN_CHUNK_SCREEN_PX && ch >= MIN_CHUNK_SCREEN_PX) return false;

    const currentZoom = map.getZoom();
    const scaleNeeded = Math.max(
      MIN_CHUNK_SCREEN_PX / Math.max(cw, 0.0001),
      MIN_CHUNK_SCREEN_PX / Math.max(ch, 0.0001)
    );
    if (!Number.isFinite(scaleNeeded) || scaleNeeded <= 1) return false;

    const desiredZoom = map.getScaleZoom(scaleNeeded, currentZoom);
    const maxZoom = map.getMaxZoom();
    const limitedZoom = Math.min(desiredZoom, Number.isFinite(maxZoom) ? maxZoom : desiredZoom);
    if (limitedZoom <= currentZoom) return false;

    map.setZoom(limitedZoom);
    return true;
  }

  function refreshChunkLayer({ viewportOnly = false, duringMove = false } = {}) {
    if (!duringMove) {
      clearTimeout(monsterPanTimer);
      monsterPanTimer = null;
    }
    if (!IMG_W || !IMG_H) return;

    if (!isOn(pillMonsters)) {
      // fully clear when turning OFF to avoid stale empty boxes when turning back ON
      clearMonsterMarkers();
      return;
    }

    if (duringMove && monsterZooming) return;
    const zoom = map.getZoom();
    const center = map.project(map.getCenter(), zoom);
    const size = map.getSize();
    const view = { x: center.x, y: center.y, zoom, floor: currentFloor, width: size.x, height: size.y };
    if ((viewportOnly || duringMove) && !monsterViewportNeedsRefresh(monsterRenderedView, view)) return;
    const now = performance.now();
    if (duringMove && now - lastMonsterPanRefresh < 80) {
      // Finish a throttled update even if the user pauses with the mouse held.
      if (monsterPanTimer === null) {
        monsterPanTimer = setTimeout(() => {
          monsterPanTimer = null;
          refreshChunkLayer({ duringMove: true });
        }, 80 - (now - lastMonsterPanRefresh));
      }
      return;
    }

    const [cw, ch] = chunkScreenSize();
    const chunkPx = Math.min(cw, ch);
    const bufferPx = monsterViewportBuffer(view);
    const b = map.getBounds();
    const [minX, minY] = toGameXY(b.getNorthWest());
    const [maxX, maxY] = toGameXY(b.getSouthEast());
    const maxCx = Math.floor(IMG_W / CHUNK_SIZE) - 1;
    const maxCy = Math.floor(IMG_H / CHUNK_SIZE) - 1;
    const selectedFloor = floorConfig(currentFloor);
    const floorMinCx = Math.floor(selectedFloor.minX / CHUNK_SIZE);
    const floorMaxCx = Math.min(maxCx, Math.ceil(selectedFloor.maxX / CHUNK_SIZE) - 1);

    const rawCx0 = Math.floor(Math.min(minX, maxX) / CHUNK_SIZE);
    const rawCx1 = Math.floor((Math.max(minX, maxX) - 1) / CHUNK_SIZE);
    const rawCy0 = Math.floor(Math.min(minY, maxY) / CHUNK_SIZE);
    const rawCy1 = Math.floor((Math.max(minY, maxY) - 1) / CHUNK_SIZE);

    if (chunkPx < MIN_CHUNK_SCREEN_PX) {
      const span = monsterOverviewGroupSpan({
        chunkScreenPx: chunkPx,
        detailMinPx: MIN_CHUNK_SCREEN_PX,
        targetScreenPx: MONSTER_OVERVIEW_TARGET_PX,
        maxSpan: MONSTER_OVERVIEW_MAX_SPAN
      });
      const firstGroupCx = Math.floor(rawCx0 / span) * span;
      const lastGroupCx = Math.floor(rawCx1 / span) * span;
      const firstGroupCy = Math.floor(rawCy0 / span) * span;
      const lastGroupCy = Math.floor(rawCy1 / span) * span;
      // Include complete groups so summaries do not change as their cells
      // cross the viewport edge.
      const padding = Math.max(1, Math.ceil(bufferPx / (span * chunkPx))) * span;
      renderMonsterOverview({
        cx0: clamp(firstGroupCx - padding, floorMinCx, floorMaxCx),
        cx1: clamp(lastGroupCx + span + padding - 1, floorMinCx, floorMaxCx),
        cy0: clamp(firstGroupCy - padding, 0, maxCy),
        cy1: clamp(lastGroupCy + span + padding - 1, 0, maxCy),
        span
      });
      monsterRenderedView = view;
      lastMonsterPanRefresh = performance.now();
      return;
    }

    clearMarkerMap(overviewTiles);

    // Prepare labels before they enter the screen while panning.
    const PAD = Math.max(1, Math.ceil(bufferPx / chunkPx));

    const cx0 = clamp(rawCx0 - PAD, floorMinCx, floorMaxCx), cx1 = clamp(rawCx1 + PAD, floorMinCx, floorMaxCx);
    const cy0 = clamp(rawCy0 - PAD, 0, maxCy), cy1 = clamp(rawCy1 + PAD, 0, maxCy);

    const keep = new Set();

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const names = namesForChunk(cx, cy);
        if (!names.length) continue;

        const key = `${cx},${cy}`;
        keep.add(key);

        const bounds = chunkBounds(cx, cy);
        const center = bounds.getCenter();

        let m = chunkTiles.get(key);
        if (!m) {
          m = L.marker(center, { pane: 'chunk', interactive: false, keyboard: false }).addTo(chunkFG);
          chunkTiles.set(key, m);
        }
        fitChunkLabel(bounds, names, m);
      }
    }

    // Prune beyond the buffer to keep the number of markers bounded.
    for (const [k, m] of chunkTiles) {
      if (!keep.has(k)) { chunkFG.removeLayer(m); chunkTiles.delete(k); }
    }
    monsterRenderedView = view;
    lastMonsterPanRefresh = performance.now();
  }

  function focusTransportPartner(partnerPoint, extraZoom = 0) {
    if (!partnerPoint) return;
    const targetZoom = transportFocusZoom({
      currentZoom: map.getZoom(),
      minZoom: map.getMinZoom(),
      maxZoom: map.getMaxZoom(),
      extraZoom
    });
    focusWorldPoint(partnerPoint.x + 0.5, partnerPoint.y + 0.5, { zoom: targetZoom, duration: 0.7 });
  }

  // -------- Caves (paired markers with teleport helper) --------
  function renderCaves(cavesArr) {
    cavesFG.clearLayers();
    const makeMarker = (latLng, partnerPoint) => {
      const marker = L.marker(latLng, {
        pane: 'portalLines',
        icon: ICONS.cave,
        interactive: true,
        keyboard: false,
        bubblingMouseEvents: false
      }).addTo(cavesFG);
      marker.on('click', () => {
        focusTransportPartner(partnerPoint);
      });
    };

    for (const c of (cavesArr || [])) {
      const ep = caveEndpoints(c);
      if (!ep) continue;
      const [x1, y1, x2, y2] = ep;
      const entryLL = toLL(x1 + 0.5, y1 + 0.5);
      const exitLL  = toLL(x2 + 0.5, y2 + 0.5);
      makeMarker(entryLL, { x: x2, y: y2 });
      makeMarker(exitLL, { x: x1, y: y1 });
    }
  }

  // -------- Portals (paired markers + labels) --------
  let portalLabelItems = [];

  function renderPortalMarkers(arr) {
    portalLinesFG.clearLayers();

    const makePortal = (latLng, partnerPoint) => {
      const interactive = !!partnerPoint;
      const marker = L.marker(latLng, {
        pane: 'portalLines',
        icon: ICONS.portal,
        interactive,
        keyboard: false,
        bubblingMouseEvents: false
      }).addTo(portalLinesFG);
      if (!interactive) return;
      marker.on('click', () => {
        focusTransportPartner(partnerPoint, 1);
      });
    };

    for (const p of arr) {
      const ep = portalEndpoints(p);
      if (!ep) continue;
      const [x1, y1, x2, y2] = ep;
      const entryLL = toLL(x1 + 0.5, y1 + 0.5);
      const exitLL  = toLL(x2 + 0.5, y2 + 0.5);
      makePortal(entryLL, { x: x2, y: y2 });
      if (p?.dir !== 'one') makePortal(exitLL, { x: x1, y: y1 });
      else makePortal(exitLL, null);
    }
  }

  function renderPortalLabels(arr) {
    for (const item of arr) {
      if (!isPortalLabelItem(item)) continue;
      const { name, x, y } = item;
      makeLabel(x, y, name, 'portal').addTo(portalsLblFG);
    }
  }

  function renderPortals(ps) {
    if (!Array.isArray(ps)) return;
    const { portalPairs, portalLabels } = splitPortalItems(ps);
    portalLabelItems = portalLabels;
    renderPortalMarkers(portalPairs);
    renderPortalLabels(portalLabelItems);
  }

  // -------- Points of Interest --------
  function renderPois(arr) {
    poisFG.clearLayers();
    for (const item of arr || []) {
      if (!item || typeof item.name !== 'string') continue;
      const { name, x, y } = item;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      makeLabel(x, y, name, 'poi').addTo(poisFG);
    }
  }

  let crimSpawnPoints = [];
  function renderCrimSpawns(arr) {
    crimFG.clearLayers();
    crimSpawnPoints = [];
    for (const item of arr || []) {
      if (!item || typeof item.name !== 'string') continue;
      const { x, y } = item;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      crimSpawnPoints.push({ x, y, name: item.name });
      L.marker(toLL(x, y), {
        pane: 'crim',
        icon: ICONS.crim,
        interactive: false,
        keyboard: false,
        bubblingMouseEvents: false
      }).addTo(crimFG);
    }
  }

  // -------- Zones (polygons + level badges) --------
  function centroidForRing(ring) {
    if (!Array.isArray(ring) || !ring.length) return null;
    let sx = 0, sy = 0, count = 0;
    for (const pt of ring) {
      if (!Array.isArray(pt)) continue;
      const [x, y] = pt;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      sx += x; sy += y; count++;
    }
    return count ? [sx / count, sy / count] : null;
  }

  function zoneLabelPoint(zone) {
    const cells = zone?.cells;
    if (Array.isArray(cells) && cells.length) {
      let sx = 0, sy = 0, count = 0;
      for (const cell of cells) {
        if (!Array.isArray(cell) || cell.length < 2) continue;
        const [cx, cy] = cell;
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
        sx += cx * CHUNK_SIZE + CHUNK_SIZE / 2;
        sy += cy * CHUNK_SIZE + CHUNK_SIZE / 2;
        count++;
      }
      if (count) return [sx / count, sy / count];
    }
    if (zone && Array.isArray(zone.label) && zone.label.length === 2) {
      const [lx, ly] = zone.label;
      if (Number.isFinite(lx) && Number.isFinite(ly)) return [lx, ly];
    }
    const firstRing = Array.isArray(zone?.polygons)
      ? zone.polygons.find(ring => Array.isArray(ring) && ring.length)
      : null;
    return firstRing ? centroidForRing(firstRing) : null;
  }

  function renderZones(zonesArr) {
    zonesFG.clearLayers();
    if (!Array.isArray(zonesArr)) return;

    const zoneColor = getZoneColor();
    for (const zone of zonesArr) {
      const rings = Array.isArray(zone?.polygons) ? zone.polygons : [];
      for (const ring of rings) {
        const latlngs = [];
        for (const pt of ring || []) {
          if (!Array.isArray(pt)) continue;
          const [x, y] = pt;
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          latlngs.push(toLL(x, y));
        }
        if (latlngs.length >= 3) {
          L.polygon(latlngs, {
            pane: 'zones',
            color: zoneColor,
            weight: 1,
            opacity: 0.55,
            fillColor: zoneColor,
            fillOpacity: 0.18,
            interactive: false,
            bubblingMouseEvents: false
          }).addTo(zonesFG);
        }
      }

      const labelText = formatZoneLevels(zone?.levels);
      if (!labelText) continue;
      const target = zoneLabelPoint(zone);
      if (!target) continue;
      const maxLevel = zoneMaxLevel(zone?.levels);
      const difficulty = zoneDifficultyStyle(maxLevel);
      const styleBits = [];
      if (difficulty.bg) styleBits.push(`background:${difficulty.bg}`);
      if (difficulty.border) styleBits.push(`border-color:${difficulty.border}`);
      if (difficulty.text) styleBits.push(`color:${difficulty.text}`);
      const badgeStyle = styleBits.length ? ` style="${styleBits.join(';')}"` : '';
      const bossLabel = difficulty.skull ? '<span class="icon" aria-hidden="true">BOSS</span>' : '';
      L.marker(toLL(target[0], target[1]), {
        pane: 'zones-labels',
        interactive: false,
        keyboard: false,
        bubblingMouseEvents: false,
        icon: L.divIcon({
          className: 'zone-level-icon',
          html: `<div class="zone-level"${badgeStyle}>${bossLabel}${escHtml(labelText)}</div>`,
          iconSize: null
        })
      }).addTo(zonesFG);
    }
  }

  function renderWarfrontLabels(data) {
    warfrontLabelsFG.clearLayers();
    const definitions = new Map(data.warfronts.map(item => [item?.id, item]));
    const allowedPatterns = new Set([
      'diagonal-down',
      'diagonal-up',
      'horizontal',
      'vertical',
      'cross-diagonal',
      'dots',
      'grid'
    ]);

    for (const label of data.labels) {
      if (!label?.primary || !Number.isFinite(label.x) || !Number.isFinite(label.y)) continue;
      const definition = definitions.get(label.id);
      const color = /^#[0-9a-f]{6}$/i.test(definition?.color || '') ? definition.color : '#ffffff';
      const pattern = allowedPatterns.has(definition?.pattern) ? definition.pattern : 'grid';
      const name = typeof label.name === 'string' ? label.name : definition?.label;
      if (!name) continue;

      L.marker(toLL(label.x, label.y), {
        pane: 'warfront-labels',
        interactive: false,
        keyboard: false,
        bubblingMouseEvents: false,
        icon: L.divIcon({
          className: 'warfront-label-icon',
          html: `<div class="warfront-label" style="--warfront-color:${color}"><span class="warfront-label-pattern warfront-pattern-${pattern}" aria-hidden="true"></span><span>${escHtml(name)}</span></div>`,
          iconSize: null
        })
      }).addTo(warfrontLabelsFG);
    }
  }

  function renderLocaleLabels(data) {
    localeLabelsFG.clearLayers();
    window.__localeSearchCache = [];
    const definitions = new Map(data.locales.map(item => [item?.id, item]));
    const allowedPatterns = new Set([
      'diagonal-down',
      'cross-diagonal',
      'grid',
      'dots',
      'horizontal'
    ]);

    for (const label of data.labels) {
      if (!label?.primary || !Number.isFinite(label.x) || !Number.isFinite(label.y)) continue;
      const definition = definitions.get(label.id);
      const color = /^#[0-9a-f]{6}$/i.test(definition?.color || '') ? definition.color : '#e5e7eb';
      const pattern = allowedPatterns.has(definition?.pattern) ? definition.pattern : 'grid';
      const name = typeof label.name === 'string' ? label.name : definition?.name;
      if (!name) continue;

      const categoryLabel = typeof definition?.category_label === 'string'
        ? definition.category_label
        : 'Locale';
      const bounds = Array.isArray(label.bounds) && label.bounds.length === 4 && label.bounds.every(Number.isFinite)
        ? label.bounds
        : null;
      window.__localeSearchCache.push({
        name,
        x: label.x,
        y: label.y,
        bounds,
        floor: label.floor,
        categoryLabel,
        aliases: Array.isArray(definition?.aliases) ? definition.aliases : []
      });

      L.marker(toLL(label.x, label.y), {
        pane: 'locale-labels',
        interactive: false,
        keyboard: false,
        bubblingMouseEvents: false,
        icon: nameIcon(
          `<span class="locale-label-content" style="--locale-color:${color}" aria-label="${escHtml(categoryLabel)}: ${escHtml(name)}"><span class="locale-label-pattern locale-pattern-${pattern}" aria-hidden="true"></span><span class="n locale">${escHtml(name)}</span></span>`
        )
      }).addTo(localeLabelsFG);
    }
  }

  // -------- Layer toggles --------
  function setLayerVisible(layer, on) {
    if (!layer) return;
    if (on && !map.hasLayer(layer)) map.addLayer(layer);
    if (!on && map.hasLayer(layer)) map.removeLayer(layer);
    rerunCollision();
  }

  pillMonsters?.addEventListener('click', () => {
    const on = !isOn(pillMonsters);
    setPill(pillMonsters, on);
    setLayerVisible(chunkFG, on);
    if (on) {
      refreshChunkLayer();
    } else {
      clearMonsterMarkers();
    }
  });

  pillPortals?.addEventListener('click', () => {
    const on = !isOn(pillPortals);
    setPill(pillPortals, on);
    setLayerVisible(portalsLblFG, on);
    setLayerVisible(portalLinesFG, on);
  });

  pillCaves?.addEventListener('click', () => {
    const on = !isOn(pillCaves);
    setPill(pillCaves, on);
    setLayerVisible(cavesFG, on);
  });

  pillPois?.addEventListener('click', () => {
    const on = !isOn(pillPois);
    setPill(pillPois, on);
    setLayerVisible(poisFG, on);
  });

  pillCrim?.addEventListener('click', () => {
    const on = !isOn(pillCrim);
    setPill(pillCrim, on);
    setLayerVisible(crimFG, on);
  });

  pillZones?.addEventListener('click', () => {
    const on = !isOn(pillZones);
    setPill(pillZones, on);
    setLayerVisible(zonesFG, on);
  });

  pillLocales?.addEventListener('click', () => {
    const on = !isOn(pillLocales);
    setPill(pillLocales, on);
    setLayerVisible(localeOverlay, on);
    setLayerVisible(localeLabelsFG, on);
  });

  pillSafeZones?.addEventListener('click', () => {
    const on = !isOn(pillSafeZones);
    setPill(pillSafeZones, on);
    setLayerVisible(safeZonesOverlay, on);
  });

  pillWarfronts?.addEventListener('click', () => {
    const on = !isOn(pillWarfronts);
    setPill(pillWarfronts, on);
    setLayerVisible(warfrontOverlay, on);
    setLayerVisible(warfrontLabelsFG, on);
  });

  // -------- Search (affects place/portal labels + chunk labels) --------
  function setSearchExpanded(expanded) {
    if (searchInput) searchInput.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function hideSearchSuggestions() {
    if (!searchSuggestions) return;
    searchSuggestions.innerHTML = '';
    searchSuggestions.classList.remove('open');
    setSearchExpanded(false);
  }

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

  function renderSearchSuggestions(entries) {
    if (!searchSuggestions) return;
    searchSuggestions.innerHTML = '';
    if (!entries.length) {
      const div = document.createElement('div');
      div.className = 'empty';
      const hasData = searchItems.length > 0;
      div.textContent = hasData ? 'No names match that search.' : 'Data not loaded yet.';
      searchSuggestions.appendChild(div);
      searchSuggestions.classList.add('open');
      setSearchExpanded(true);
      return;
    }
    const frag = document.createDocumentFragment();
    entries.slice(0, SEARCH_SUGGESTION_LIMIT).forEach(entry => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'search-suggestion';
      btn.dataset.name = entry.name;
      const isMonster = entry.type === 'monster';
      const lvl = isMonster && Number.isFinite(entry.level) ? `<span class="meta">Lv ${entry.level}</span>` : '';
      const floorMeta = !isMonster && Number.isFinite(entry.x) ? ` · ${floorLabelForX(entry.x)}` : '';
      const entryTypeLabel = entry.type === 'poi' ? 'POI' : (entry.categoryLabel || 'Locale');
      const tag = !isMonster ? `<span class="meta">${escHtml(entryTypeLabel)}${floorMeta}</span>` : '';
      btn.innerHTML = `<span class="name">${escHtml(entry.name)}</span>${lvl || tag}`;
      btn.addEventListener('click', () => commitSearch(entry, { focus: true }));
      frag.appendChild(btn);
    });
    searchSuggestions.appendChild(frag);
    searchSuggestions.classList.add('open');
    setSearchExpanded(true);
  }

  function handleSearchInput() {
    if (!searchInput) return;
    const val = searchInput.value || '';
    if (!val.trim()) {
      hideSearchSuggestions();
      if (currentSearchRegex) runSearch(false);
      return;
    }
    renderSearchSuggestions(findSearchSuggestions(val));
  }

  function findSearchEntryByName(name) {
    return findSearchEntryInList(searchItems, name);
  }

  function activeSearchTypeForRun(term, exact, preferredEntry = null) {
    const entry = exact ? (preferredEntry || findSearchEntryByName(term)) : null;
    currentSearchType = searchTypeForRun({
      term,
      exact,
      currentSearchType,
      entry
    });
    return currentSearchType;
  }

  function ensureLabelLayerOn(type) {
    const layerKey = labelLayerKeyForSearchType(type);
    if (layerKey === 'pois') {
      if (!isOn(pillPois)) { setPill(pillPois, true); setLayerVisible(poisFG, true); }
    } else if (layerKey === 'locales') {
      if (!isOn(pillLocales)) {
        setPill(pillLocales, true);
        setLayerVisible(localeOverlay, true);
        setLayerVisible(localeLabelsFG, true);
      }
    }
  }

  function showLocaleSearchHighlight(entry) {
    localeSearchFG.clearLayers();
    if (entry?.type !== 'locale') return;
    const bounds = entry.bounds;
    if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) return;
    const [x0, y0, x1, y1] = bounds;
    L.rectangle(L.latLngBounds(toLL(x0, y0), toLL(x1, y1)), {
      pane: 'deep-link',
      className: 'locale-search-highlight',
      color: '#ffd60a',
      weight: 4,
      opacity: 1,
      dashArray: '9 6',
      fill: true,
      fillColor: '#ffd60a',
      fillOpacity: 0.05,
      interactive: false
    }).addTo(localeSearchFG);
  }

  function focusOnEntry(entry) {
    const target = searchEntryFocusTarget({
      entry,
      currentZoom: map.getZoom(),
      minZoom: map.getMinZoom(),
      maxZoom: map.getMaxZoom()
    });
    if (target.kind === 'matches') return focusOnSearchMatches();
    return focusWorldPoint(target.x, target.y, { zoom: target.zoom, duration: target.duration });
  }

  function commitSearch(termOrEntry, opts = {}) {
    const { focus = true, exact = true } = opts;
    if (!searchInput) return;
    const entry = typeof termOrEntry === 'string' ? findSearchEntryByName(termOrEntry) : termOrEntry;
    const clean = typeof termOrEntry === 'string' ? (termOrEntry || '').trim() : (entry?.name || '').trim();
    searchInput.value = clean;
    hideSearchSuggestions();
    currentSearchType = clean ? (entry?.type || null) : null;
    currentSearchEntry = clean ? (entry || null) : null;
    if (!clean) {
      runSearch(false);
      return;
    }
    if (entry?.type === 'monster') {
      ensureMonstersLayerOn(true);
    } else {
      ensureLabelLayerOn(entry?.type);
    }
    runSearch(exact, entry);
    if (focus) focusOnEntry(entry);
  }

  function runSearch(exact = false, preferredEntry = null) {
    const q = (searchInput?.value || '').trim();
    persistSearchToUrl(q);
    const exactEntry = exact
      ? (preferredEntry || (currentSearchEntry?.name === q ? currentSearchEntry : null) || findSearchEntryByName(q))
      : null;
    currentSearchRegex = createSearchRegex(exactEntry?.name || q, exact);
    if (!currentSearchRegex) {
      currentSearchType = null;
      currentSearchEntry = null;
    }
    const activeSearchType = activeSearchTypeForRun(q, exact, exactEntry);
    showLocaleSearchHighlight(exactEntry);

    const markerGroups = [portalsLblFG, poisFG, localeLabelsFG];

    // reset
    markerGroups.forEach(g => g.eachLayer(layer => {
      const el = layer.getElement && layer.getElement(); if (!el) return;
      const span = el.querySelector('span.n'); if (span) span.classList.remove('match');
      el.style.display = ''; el.style.visibility = '';
      if (layer.setZIndexOffset) layer.setZIndexOffset(0);
    }));

    markerGroups.forEach(g => g.eachLayer(layer => {
      const el = layer.getElement && layer.getElement(); if (!el) return;
      const span = el.querySelector('span.n'); if (!span) return;
      const markerState = searchLabelMarkerState({
        labelText: span.textContent || '',
        searchRegex: currentSearchRegex,
        activeSearchType
      });
      if (markerState.matches) {
        span.classList.add('match');
        if (layer.setZIndexOffset) layer.setZIndexOffset(MATCH_ZINDEX_OFFSET);
      } else if (markerState.hidden) {
        el.style.display = 'none';
      }
    }));

    refreshChunkLayer();
    rerunCollision();
  }

  setSearchExpanded(false);
  searchInput?.addEventListener('input', handleSearchInput);
  searchInput?.addEventListener('focus', () => {
    if ((searchInput.value || '').trim()) handleSearchInput();
  });
  searchInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = searchSuggestions?.querySelector('.search-suggestion');
      if (first) first.click();
      else {
        const candidate = (searchInput.value || '').trim();
        if (candidate) commitSearch(findSearchEntryByName(candidate) || candidate, { focus: true, exact: true });
        else hideSearchSuggestions();
      }
      e.stopPropagation();
    } else if (e.key === 'Escape') {
      hideSearchSuggestions();
      e.stopPropagation();
    }
  });
  document.addEventListener('click', e => {
    if (!searchSuggestions) return;
    const wrap = searchSuggestions.parentElement;
    if (wrap && wrap.contains(e.target)) return;
    hideSearchSuggestions();
  });

  const initialSearchTerm = readSearchFromUrl();
  const startedWithSearch = !!(initialSearchTerm && initialSearchTerm.trim());
  const initialCoordinateTarget = readCoordinateTargetFromUrl();
  const startedWithCoordinateTarget = !!initialCoordinateTarget;
  if (initialSearchTerm && searchInput) {
    searchInput.value = initialSearchTerm;
    runSearch(true); // immediate for deep links (exact match)
  }
  function ensureMonstersLayerOn(requestRefresh = false) {
    const wasOff = !isOn(pillMonsters);
    if (wasOff) {
      setPill(pillMonsters, true);
      setLayerVisible(chunkFG, true);
    }
    if (requestRefresh || wasOff) {
      const zoomAdjusted = ensureMonstersZoom();
      if (zoomAdjusted) map.once('zoomend', refreshChunkLayer);
      else refreshChunkLayer();
    }
  }

  function bestSearchClusterCenter() {
    return bestSearchClusterCenterValue({
      encountersIndex,
      searchRegex: currentSearchRegex,
      radius: SEARCH_CLUSTER_RADIUS
    });
  }

  function bestSearchLabelZoom() {
    return searchLabelZoomValue({
      minZoom: map.getMinZoom(),
      maxZoom: map.getMaxZoom(),
      currentZoom: map.getZoom(),
      neededPx: requiredChunkPxForSearchTerm(searchInput?.value || ''),
      chunkScreenSizeAtZoom
    });
  }

  function focusOnSearchMatches() {
    const center = bestSearchClusterCenter();
    if (!center) return false;
    const cxCenter = (center.cx + 0.5) * CHUNK_SIZE;
    const cyCenter = (center.cy + 0.5) * CHUNK_SIZE;
    const targetZoom = bestSearchLabelZoom();
    return focusWorldPoint(cxCenter, cyCenter, { zoom: targetZoom, duration: 0.8, zoomBoost: 0 });
  }

  monsterLevelMinSelect?.addEventListener('change', () => handleMonsterLevelSelectChange('min'));
  monsterLevelMaxSelect?.addEventListener('change', () => handleMonsterLevelSelectChange('max'));
  monsterLevelExclusiveBtn?.addEventListener('click', () => setMonsterLevelExclusive(!monsterFilterExclusive));
  syncMonsterLevelExclusiveBtn();

  function exposeTestApi() {
    if (typeof window === 'undefined') return;
    if (!window.__PROJECT_ROGUE_TEST_HOOKS__) return;
    window.__PROJECT_ROGUE_TEST_HOOKS__.api = {
      commitSearch,
      groups: { localeLabelsFG, poisFG },
      elements: { searchInput, pillLocales, pillPois }
    };
  }

  // -------- Image/map load --------
  const baseImg = new Image();
  baseImg.src = IMG_PATH;
  baseImg.onload = () => {
    IMG_W = baseImg.naturalWidth || baseImg.width; // fallback for older engines
    IMG_H = baseImg.naturalHeight;

    const bounds = [[0, 0], [IMG_H, IMG_W]];
    const overlay = L.imageOverlay(IMG_PATH, bounds, { className: 'map-image', interactive: false }).addTo(map);
    safeZonesOverlay = L.imageOverlay(SAFE_ZONE_IMG_PATH, bounds, {
      pane: 'safe-zones',
      className: 'safe-zone-image',
      interactive: false
    });
    localeOverlay = L.imageOverlay(LOCALES_IMG_PATH, bounds, {
      pane: 'locales',
      className: 'locale-image',
      interactive: false
    });
    warfrontOverlay = L.imageOverlay(WARFRONT_IMG_PATH, bounds, {
      pane: 'warfronts',
      className: 'warfront-image',
      interactive: false
    });

    // final mapping (apply Y flip if requested)
    toLL = (x, y) => L.latLng(mapLat(y), x);

    const initialFloorBounds = currentFloorBounds();
    floorMinZoom = map.getBoundsZoom(initialFloorBounds, true) - ZOOM_OUT_EXTRA;
    map.setMinZoom(floorMinZoom);
    map.setMaxZoom(floorMinZoom + 6);
    refreshFloorViewport();
    map.fitBounds(initialFloorBounds, { animate: false });
    map.setZoom(floorMinZoom);

    if (isOn(pillSafeZones)) setLayerVisible(safeZonesOverlay, true);
    if (isOn(pillLocales)) setLayerVisible(localeOverlay, true);
    if (isOn(pillWarfronts)) setLayerVisible(warfrontOverlay, true);

    overlay.once('load', () => {
      const el = overlay.getElement();
      if (!el) return;
      el.style.textRendering = 'optimizeLegibility';
      el.style.imageRendering = 'pixelated';
    });

    Promise.all([
      fetch(DATA.portals).then(r => r.json()).catch(() => []),
      fetch(DATA.encounters).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(DATA.caves).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(DATA.zones).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(DATA.pois).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(DATA.crim).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(DATA.monsterLvls).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(DATA.locales).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(DATA.warfronts).then(r => r.ok ? r.json() : null).catch(() => null)
    ]).then(([portalsJson, enc, caves, zonesJson, poisJson, crimJson, monsterLvlJson, localeJson, warfrontJson]) => {
      // Portals (build once; layers OFF until toggled)
      renderPortals(normalizePortalList(portalsJson));

      // Encounters (Monsters)
      encountersIndex = normalizeEncounterIndex(enc);

      // Caves (build once; layer OFF until toggled)
      renderCaves(normalizeCaveList(caves));

      // Zones (build once; layer OFF until toggled)
      renderZones(normalizeZoneList(zonesJson));

      // Locales pair client-derived regions with canonical names and are enabled by default.
      renderLocaleLabels(normalizeLocaleData(localeJson));

      // Warfront labels pair with the generated raster overlay and stay OFF until toggled.
      renderWarfrontLabels(normalizeWarfrontData(warfrontJson));

      // POIs (build once; layer OFF until toggled)
      window.__poiDataCache = normalizePoiList(poisJson);
      renderPois(window.__poiDataCache);

      // Crim spawns
      renderCrimSpawns(normalizeCrimList(crimJson));

      // Monster levels lookup
      monsterLevels = normalizeMonsterLevels(monsterLvlJson);
      chunkLabelLayouts.clear();
      updateMonsterLevelSelectOptions();
      buildSearchIndex();
      if (searchInput && searchInput.value.trim() && document.activeElement === searchInput) {
        handleSearchInput();
      }

      // Set initial pill states
      setPill(pillMonsters, false);
      setPill(pillPortals, false);
      setPill(pillCaves, false);
      setPill(pillPois, false);
      setPill(pillCrim, false);
      setPill(pillZones, false);
      setPill(pillLocales, true);
      setPill(pillSafeZones, false);
      setPill(pillWarfronts, false);
      setLayerVisible(safeZonesOverlay, false);
      setLayerVisible(localeOverlay, true);
      setLayerVisible(localeLabelsFG, true);
      setLayerVisible(warfrontOverlay, false);
      setLayerVisible(warfrontLabelsFG, false);
      setLayerVisible(poisFG, false);
      setLayerVisible(portalsLblFG, false);
      setLayerVisible(portalLinesFG, false);
      setLayerVisible(cavesFG, false);
      const hasActiveSearch = !!(searchInput?.value && searchInput.value.trim());
      let refreshedViaSearch = false;
      if (startedWithSearch && hasActiveSearch) {
        const entry = findSearchEntryByName(searchInput.value);
        if (entry?.type === 'monster') {
          ensureMonstersLayerOn(true);
          refreshedViaSearch = true;
        } else {
          ensureLabelLayerOn(entry?.type);
        }
        currentSearchEntry = entry;
        runSearch(true, entry); // apply the deep-linked search to freshly-added labels
      }

      const focusedCoordinateTarget = startedWithCoordinateTarget
        ? focusCoordinateTarget(initialCoordinateTarget, { duration: 0.8, zoomBoost: 4 })
        : null;
      if (focusedCoordinateTarget) {
        setCoordDisplay(focusedCoordinateTarget.x, focusedCoordinateTarget.y);
      } else if (startedWithSearch && hasActiveSearch) {
        const entry = findSearchEntryByName(searchInput.value);
        const focused = entry ? focusOnEntry(entry) : focusOnSearchMatches();
        if (!focused) {
          const candidates = initialViewTargets();
          const randomSpot = randomArrayItem(candidates);
          if (randomSpot) map.setView(toLL(randomSpot.x, randomSpot.y), map.getZoom(), { animate: false });
        }
      } else {
        const candidates = initialViewTargets();
        const randomSpot = randomArrayItem(candidates);
        if (randomSpot) {
          map.setView(toLL(randomSpot.x, randomSpot.y), map.getZoom(), { animate: false });
        }
      }

      if (!refreshedViaSearch) refreshChunkLayer(); // no-op until Monsters ON
      rerunCollision();
    });

    // live coords
    function setCoordDisplay(x, y) {
      const node = $('#coordStats'); if (!node) return;
      node.innerHTML = `
        <span class="pill"><span class="lbl">X</span><span class="val">${x}</span></span>
        <span class="pill"><span class="lbl">Y</span><span class="val">${y}</span></span>`;
    }
    map.on('mousemove', e => { const [x, y] = toGameXY(e.latlng); setCoordDisplay(x, y); });
  };

  // -------- Map tools --------
  mapTools = createMapTools({
    L, map, routes, eliteFG, respawnFG, floors: FLOORS, chunkSize: CHUNK_SIZE,
    getFloor: () => currentFloor, getImageHeight: () => IMG_H,
    toGameXY, toLL: (x, y) => toLL(x, y),
    getCrimSpawns: () => crimSpawnPoints, getCrimColor, switchFloor, panel,
    collapsePanel: () => setPanelCollapsed(true)
  });
  window.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== searchInput) {
      e.preventDefault(); searchInput.focus(); searchInput.select();
    }
  });
  // -------- Collision hider (map labels) --------
  function markerPriority(spanEl) {
    let score = 1;
    if (spanEl.classList.contains('portal')) score = 2;
    if (spanEl.classList.contains('poi'))    score = 2;
    if (spanEl.classList.contains('locale')) score = 4;
    if (spanEl.classList.contains('match'))  score += 100;
    return score;
  }

  function rerunCollision() {
    const size = map.getSize();
    const CELL = 28, cols = Math.ceil(size.x / CELL) + 2, rows = Math.ceil(size.y / CELL) + 2;
    const grid = Array.from({ length: cols * rows }, () => []);
    const idx  = (cx, cy) => cy * cols + cx;

    const consider = group => {
      if (!map.hasLayer(group)) return;
      group.eachLayer(m => {
        const el = m.getElement && m.getElement(); if (!el) return;
        const latlng = m.getLatLng && m.getLatLng();
        const markerFloor = Number.isFinite(latlng?.lng) ? floorForX(latlng.lng) : currentFloor;
        if (markerFloor !== currentFloor) {
          el.dataset.floorHidden = '1';
          el.style.visibility = 'hidden';
          return;
        }
        if (el.dataset.floorHidden === '1') {
          delete el.dataset.floorHidden;
          el.style.visibility = '';
        }
        if (el.style.display === 'none'){ el.style.attach = ''; el.style.visibility = 'hidden'; return; }
        const span = el.querySelector('span.n');  if (!span) return;

        // Labels are centered on their marker; viewport checks must include
        // the pane translation while panning, and the visible label's size.
        const pt = map.latLngToContainerPoint(m.getLatLng());
        const inner = el.querySelector('.lbl-inner');
        const w = inner?.offsetWidth || (span.textContent.length * 7 + 6);
        const h = inner?.offsetHeight || (span.classList.contains('locale') ? 20 : 14);
        const r = { x: pt.x - w / 2, y: pt.y - h / 2, w, h, score: markerPriority(span) };

        if (r.x > size.x || r.y > size.y || r.x + r.w < 0 || r.y + r.h < 0) {
          el.style.visibility = 'hidden';
          return;
        }

        const cx0 = Math.floor(Math.max(0, r.x) / CELL);
        const cy0 = Math.floor(Math.max(0, r.y) / CELL);
        const cx1 = Math.floor(Math.min(size.x, r.x + r.w) / CELL);
        const cy1 = Math.floor(Math.min(size.y, r.y + r.h) / CELL);

        // check collisions against what’s already kept in those bins
        let collide = false;
        for (let gy = 0; gy <= (cy1 - cy0) && !collide; gy++) {
          for (let gx = 0; gx <= (cx1 - cx0) && !collide; gx++) {
            const bin = grid[idx(cx0 + gx, cy0 + gy)];
            for (const o of bin) {
              if (!(r.x >= o.x + o.w || r.x + r.w <= o.x || r.y >= o.y + o.h || r.y + r.h <= o.y)) {
                // Prefer higher score (locales > place labels, matches > non-matches).
                if (o.score >= r.score) { collide = true; break; }
                // else replace existing with current
                o.el.style.visibility = 'hidden';
                bin.splice(bin.indexOf(o), 1);
              }
            }
          }
        }

        if (collide) {
          el.style.visibility = 'hidden';
        } else {
          el.style.visibility = '';
          for (let gy = cy0; gy <= cy1; gy++) {
            for (let gx = cx0; gx <= cx1; gx++) {
              grid[idx(gx, gy)].push({ ...r, el });
            }
          }
        }
      });
    };

    consider(poisFG);
    consider(portalsLblFG);
    consider(localeLabelsFG);
    adjustFloorLabelOffsets();
  }

  function adjustFloorLabelOffsets() {
    if (!IMG_W || !IMG_H) return;
    const container = map.getContainer();
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const cfg = floorConfig(currentFloor);
    const seamX = currentFloor === 'overworld'
      ? map.latLngToContainerPoint(toLL(cfg.maxX, IMG_H / 2)).x
      : map.latLngToContainerPoint(toLL(cfg.minX, IMG_H / 2)).x;
    const padding = 10;

    const adjustGroup = group => {
      if (!map.hasLayer(group)) return;
      group.eachLayer(layer => {
        const el = layer.getElement && layer.getElement();
        if (!el) return;
        const inner = el.querySelector('.lbl-inner');
        if (!inner) return;
        const latlng = layer.getLatLng && layer.getLatLng();
        const labelFloor = Number.isFinite(latlng?.lng) ? floorForX(latlng.lng) : currentFloor;
        inner.style.setProperty('--floor-shift-x', '0px');
        if (labelFloor !== currentFloor) {
          el.dataset.floorHidden = '1';
          el.style.visibility = 'hidden';
          return;
        }
        if (el.dataset.floorHidden === '1') {
          delete el.dataset.floorHidden;
          el.style.visibility = '';
        }
        if (el.style.display === 'none') return;
        if (el.style.visibility === 'hidden') return;
        const rect = inner.getBoundingClientRect();
        const left = rect.left - containerRect.left;
        const right = rect.right - containerRect.left;
        let shift = 0;
        if (currentFloor === 'overworld' && right > seamX - padding) {
          shift = seamX - padding - right;
        } else if (currentFloor === 'underground' && left < seamX + padding) {
          shift = seamX + padding - left;
        }
        if (shift) {
          inner.style.setProperty('--floor-shift-x', `${Math.round(shift)}px`);
        }
      });
    };

    adjustGroup(portalsLblFG);
    adjustGroup(poisFG);
    adjustGroup(localeLabelsFG);
  }

  // -------- Map change hooks --------
  let collisionFrame = null;
  map.on('move resize', () => {
    if (collisionFrame !== null) return;
    collisionFrame = requestAnimationFrame(() => {
      collisionFrame = null;
      refreshChunkLayer({ duringMove: true });
      rerunCollision();
    });
  });
  map.on('dragstart', () => {
    monsterZooming = false; // Dragging can interrupt a search's zoom animation.
  });
  map.on('zoomstart', () => { monsterZooming = true; });
  map.on('zoomend', () => {
    monsterZooming = false;
    refreshChunkLayer({ viewportOnly: true });
    rerunCollision();
  });
  map.on('resize', () => refreshChunkLayer({ viewportOnly: true }));
  map.on('moveend',  () => {
    refreshChunkLayer({ viewportOnly: true });
    rerunCollision();
  });

  exposeTestApi();
})();
