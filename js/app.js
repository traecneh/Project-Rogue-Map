/* global L */  // hint for editors with TS/JS type checking
// If VS Code still flags DOM/Leaflet types, you can uncomment the next line:
// // @ts-nocheck

(() => {
  const IMG_PATH = './img/Map_Combined.png';
  const DATA = {
    towns:      './data/towns.json',
    portals:    './data/portals.json',      // labels and/or connections
    encounters: './data/encounters.json',   // source for Monsters (chunk labels)
    caves:      './data/caves.json',
    zones:      './data/zones.json',
    pois:       './data/poi.json',
    crim:       './data/crim_spawns.json',
    monsterLvls:'./data/monster_levels.json'
  };

  const INVERT_Y = true;
  const ZOOM_OUT_EXTRA = 3;
  const MATCH_ZINDEX_OFFSET = 10000;

  // Chunk constants
  const CHUNK_SIZE = 16;          // pixels per chunk
  const MIN_CHUNK_SCREEN_PX = 26; // minimum on-screen chunk size to draw label stacks

  // -------- Map & panes --------
  const map = L.map('map', {
    crs: L.CRS.Simple,
    zoomControl: true,
    zoomSnap: 1,
    zoomDelta: 1,
    zoomAnimation: false,
    fadeAnimation: false,
    inertia: true,
    preferCanvas: true
  });

  map.createPane('routes').style.zIndex         = 640;
  map.createPane('zones').style.zIndex          = 642;
  map.createPane('zones-labels').style.zIndex   = 643;
  map.createPane('chunk').style.zIndex          = 648;  // under portals
  map.createPane('crim').style.zIndex           = 649;
  map.createPane('labels-portals').style.zIndex = 652;
  map.createPane('portalLines').style.zIndex    = 653;  // interactive transport nodes (portals/caves)
  map.createPane('labels-towns').style.zIndex   = 655;
  map.createPane('elite').style.zIndex          = 670;

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

  // -------- Layers (only Towns added by default) --------
  const towns         = L.layerGroup().addTo(map); // ON by default
  const portalsLblFG  = L.layerGroup();            // OFF at load
  const portalLinesFG = L.featureGroup();          // OFF at load
  const routes        = L.featureGroup().addTo(map);
  const chunkFG       = L.featureGroup();          // OFF at load (Monsters)
  const cavesFG       = L.featureGroup();          // OFF at load
  const crimFG        = L.featureGroup();          // OFF at load
  const poisFG        = L.layerGroup().addTo(map); // ON by default
  const zonesFG       = L.featureGroup();          // OFF at load
  const eliteFG       = L.featureGroup().addTo(map);

  // -------- UI hooks --------
  const $ = sel => document.querySelector(sel);
  const debounce = (fn, ms = 120) => { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; };
  const escHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const readCssVar = name => {
    const root = typeof document !== 'undefined' ? document.documentElement : null;
    if (!root) return '';
    return getComputedStyle(root).getPropertyValue(name).trim();
  };
  const getZoneColor = () => readCssVar('--zone-color') || '#f59e0b';
  const getCrimColor = () => readCssVar('--crim-color') || '#fb7185';

  // Pills (defaults: Towns ON, others OFF)
  const pillMonsters = $('#pillMonsters');
  const pillTowns    = $('#pillTowns');
  const pillPortals  = $('#pillPortals');
  const pillCaves    = $('#pillCaves');
  const pillZones    = $('#pillZones');
  const pillPois     = $('#pillPois');
  const pillCrim     = $('#pillCrim');
  const searchInput  = $('#search');
  const btnVibeOut   = $('#btnVibeOut');
  const panel        = $('#panel');
  const btnCollapse  = $('#btnCollapse');

  function setPill(btn, on) { if (btn) { btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', on ? 'true' : 'false'); } }
  function isOn(btn)       { return !!btn && btn.classList.contains('on'); }

  function nameIcon(innerHtml)  {
    return L.divIcon({
      className: 'lbl',
      html: `<div class="lbl-inner">${innerHtml}</div>`,
      iconSize: null
    });
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
  // lat = y, lng = x for CRS.Simple; we’ll set the final mapping after image load (needs IMG_H for Y flip)
  let toLL = (x, y) => L.latLng(y, x);

  function toGameXY(ll) {
    const x = clamp(Math.round(ll.lng), 0, IMG_W);
    const yTop = clamp(Math.round(ll.lat), 0, IMG_H);
    return [x, INVERT_Y ? (IMG_H - yTop) : yTop];
  }

  const paneByKind = {
    town: 'labels-towns',
    poi:  'labels-towns',
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

  function vibeTargets() {
    const combined = [
      ...(Array.isArray(window.__townDataCache) ? window.__townDataCache : []),
      ...(Array.isArray(window.__poiDataCache) ? window.__poiDataCache : [])
    ].filter(it => Number.isFinite(it?.x) && Number.isFinite(it?.y));
    return combined;
  }

  const VIBE_TRANSITIONS = [
    {
      name: 'fly',
      run: ({ latlng, duration, targetZoom }) =>
        map.flyTo(latlng, targetZoom, { duration, easeLinearity: 0.25 })
    },
    {
      name: 'pan',
      run: ({ latlng, duration, targetZoom, currentZoom }) => {
        map.panTo(latlng, { animate: true, duration });
        if (targetZoom !== currentZoom) {
          map.once('moveend', () => {
            map.flyTo(latlng, targetZoom, { duration: Math.max(0.6, duration * 0.4), easeLinearity: 0.3 });
          });
        }
      }
    },
    {
      name: 'zoomIn',
      run: ({ latlng, duration, targetZoom, currentZoom }) => {
        const zoom = Math.max(currentZoom + 1, targetZoom);
        map.flyTo(latlng, clamp(zoom, map.getMinZoom(), map.getMaxZoom()), { duration, easeLinearity: 0.35 });
      }
    },
    {
      name: 'zoomOut',
      run: ({ latlng, duration, targetZoom, currentZoom }) => {
        const zoom = Math.min(currentZoom - 1, targetZoom);
        map.flyTo(latlng, clamp(zoom, map.getMinZoom(), map.getMaxZoom()), { duration, easeLinearity: 0.35 });
      }
    },
    {
      name: 'portalHop',
      run: ({ latlng, duration, targetZoom }) =>
        map.flyTo(latlng, targetZoom, { duration: Math.max(0.6, duration * 0.5), easeLinearity: 0.2 })
    }
  ];

  function startVibeLoop() {
    stopVibeLoop();
    const hop = () => {
      const targets = vibeTargets();
      if (!targets.length) return;
      const next = randomArrayItem(targets);
      const latlng = toLL(next.x, next.y);
      const transition = randomArrayItem(VIBE_TRANSITIONS);
      const duration = Math.random() * 19 + 1; // 1-20 seconds
      const zoomOptions = [-2, -1, 0, 1, 2];
      const currentZoom = map.getZoom();
      const delta = randomArrayItem(zoomOptions);
      const targetZoom = clamp(currentZoom + delta, map.getMinZoom(), map.getMaxZoom());
      transition.run({ latlng, duration, targetZoom, currentZoom });
      let synced = false;
      const sync = () => {
        if (synced) return;
        synced = true;
        refreshChunkLayer();
        rerunCollision();
      };
      map.once('moveend', sync);
      map.once('zoomend', sync);
      vibeTimer = setTimeout(hop, duration * 1000 + 5000);
    };
    hop();
  }

  function stopVibeLoop() {
    if (vibeTimer) {
      clearTimeout(vibeTimer);
      vibeTimer = null;
    }
  }

  // -------- Monsters (chunk labels) via encounters.json only --------
  const chunkTiles = new Map();   // key "cx,cy" -> L.Marker
  let encountersIndex = null;     // Map<"cx,cy", string[]>
  let monsterLevels = null;       // Map<monster name, level>
  let currentSearchRegex = null;
  let vibeTimer = null;

  function namesForChunk(cx, cy) {
    if (!encountersIndex) return [];
    const arr = encountersIndex.get(`${cx},${cy}`);
    if (!Array.isArray(arr) || !arr.length) return [];
    const uniq = Array.from(new Set(arr)).sort((a, b) => a.localeCompare(b));
    return currentSearchRegex ? uniq.filter(n => currentSearchRegex.test(n)) : uniq;
  }

  const normalizeMonsterName = name => (name || '').trim().toLowerCase();
  function monsterLevel(name) {
    if (!monsterLevels) return null;
    const lvl = monsterLevels.get(normalizeMonsterName(name));
    return Number.isFinite(lvl) ? lvl : null;
  }
  function isBossMonster(name) {
    const lvl = monsterLevel(name);
    return Number.isFinite(lvl) && lvl >= ZONE_BOSS_LEVEL;
  }

  function chunkBounds(cx, cy) {
    const x0 = cx * CHUNK_SIZE, y0 = cy * CHUNK_SIZE;
    return L.latLngBounds(toLL(x0, y0), toLL(x0 + CHUNK_SIZE, y0 + CHUNK_SIZE));
  }

  function applyInner(el, w, h, names) {
    const inner = el.querySelector('.chunk-label-inner'); if (!inner) return;
    inner.classList.remove('compact');
    inner.innerHTML = names.map(n => {
      const boss = isBossMonster(n);
      const cls = boss ? 'line boss-monster' : 'line';
      return `<div class="${cls}">${escHtml(n)}</div>`;
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
      inner.innerHTML = `<span class="chunk-count">${names.length}</span>`;
    }
  }

  function fitChunkLabel(bounds, names, marker) {
    const tl = map.latLngToLayerPoint(bounds.getNorthWest());
    const br = map.latLngToLayerPoint(bounds.getSouthEast());
    const w = Math.max(8, Math.round(br.x - tl.x));
    const h = Math.max(8, Math.round(br.y - tl.y));

    const key = names.join('|');
    if (marker._lastW === w && marker._lastH === h && marker._lastHash === key) return;
    marker._lastW = w; marker._lastH = h; marker._lastHash = key;

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

  function refreshChunkLayer() {
    if (!IMG_W || !IMG_H) return;

    if (!isOn(pillMonsters)) {
      // fully clear when turning OFF to avoid stale empty boxes when turning back ON
      chunkFG.clearLayers();
      chunkTiles.clear();
      return;
    }

    const [cw, ch] = chunkScreenSize();
    if (!currentSearchRegex && (cw < MIN_CHUNK_SCREEN_PX || ch < MIN_CHUNK_SCREEN_PX)) {
      chunkFG.clearLayers();
      chunkTiles.clear();
      return;
    }

    // Visible chunk range with ±1 padding to avoid edge pop-in
    const PAD = 1;
    const b = map.getBounds();
    const [minX, minY] = toGameXY(b.getNorthWest());
    const [maxX, maxY] = toGameXY(b.getSouthEast());
    const maxCx = Math.floor(IMG_W / CHUNK_SIZE) - 1;
    const maxCy = Math.floor(IMG_H / CHUNK_SIZE) - 1;

    const rawCx0 = Math.floor(Math.min(minX, maxX) / CHUNK_SIZE) - PAD;
    const rawCx1 = Math.floor((Math.max(minX, maxX) - 1) / CHUNK_SIZE) + PAD;
    const rawCy0 = Math.floor(Math.min(minY, maxY) / CHUNK_SIZE) - PAD;
    const rawCy1 = Math.floor((Math.max(minY, maxY) - 1) / CHUNK_SIZE) + PAD;

    const cx0 = clamp(rawCx0, 0, maxCx), cx1 = clamp(rawCx1, 0, maxCx);
    const cy0 = clamp(rawCy0, 0, maxCy), cy1 = clamp(rawCy1, 0, maxCy);

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
        } else {
          m.setLatLng(center);
        }
        fitChunkLabel(bounds, names, m);
      }
    }

    // Prune off-screen markers
    for (const [k, m] of chunkTiles) {
      if (!keep.has(k)) { chunkFG.removeLayer(m); chunkTiles.delete(k); }
    }
  }
  const refreshChunkLayerDebounced = debounce(refreshChunkLayer, 120);

  // -------- Caves (paired markers with teleport helper) --------
  function renderCaves(cavesArr) {
    cavesFG.clearLayers();
    const makeMarker = (latLng, partnerLatLng) => {
      const marker = L.marker(latLng, {
        pane: 'portalLines',
        icon: ICONS.cave,
        interactive: true,
        keyboard: false,
        bubblingMouseEvents: false
      }).addTo(cavesFG);
      marker.on('click', () => {
        if (!partnerLatLng) return;
        const minZoom = map.getMinZoom();
        const baseZoom = Number.isFinite(minZoom) ? minZoom + 2 : map.getZoom();
        const desiredZoom = Math.max(map.getZoom(), baseZoom);
        const maxZoom = map.getMaxZoom();
        const targetZoom = Number.isFinite(maxZoom) ? Math.min(desiredZoom, maxZoom) : desiredZoom;
        map.flyTo(partnerLatLng, targetZoom, { animate: true, duration: 0.7 });
      });
    };

    for (const c of (cavesArr || [])) {
      if (!c || !c.entry || !c.exit) continue;
      const entryLL = toLL(c.entry.x + 0.5, c.entry.y + 0.5);
      const exitLL  = toLL(c.exit.x  + 0.5, c.exit.y  + 0.5);
      makeMarker(entryLL, exitLL);
      makeMarker(exitLL, entryLL);
    }
  }

  // -------- Portals (paired markers + labels) --------
  let portalLabelItems = [];

  function getEndpoints(o) {
    if (o && o.entry && o.exit) return [o.entry.x, o.entry.y, o.exit.x, o.exit.y];
    if (o && o.from  && o.to)   return [o.from.x,  o.from.y,  o.to.x,   o.to.y];
    if (o && o.a     && o.b)    return [o.a.x,     o.a.y,     o.b.x,    o.b.y];
    if (o && Number.isFinite(o.x1) && Number.isFinite(o.y1) &&
             Number.isFinite(o.x2) && Number.isFinite(o.y2)) return [o.x1, o.y1, o.x2, o.y2];
    return null;
  }
  function isLabelItem(o) { return o && Number.isFinite(o.x) && Number.isFinite(o.y) && typeof o.name === 'string'; }

  function renderPortalMarkers(arr) {
    portalLinesFG.clearLayers();

    const makePortal = (latLng, partnerLatLng) => {
      const interactive = !!partnerLatLng;
      const marker = L.marker(latLng, {
        pane: 'portalLines',
        icon: ICONS.portal,
        interactive,
        keyboard: false,
        bubblingMouseEvents: false
      }).addTo(portalLinesFG);
      if (!interactive) return;
      marker.on('click', () => {
        const minZoom = map.getMinZoom();
        const baseZoom = Number.isFinite(minZoom) ? minZoom + 2 : map.getZoom();
        const desiredZoom = Math.max(map.getZoom(), baseZoom + 1);
        const maxZoom = map.getMaxZoom();
        const targetZoom = Number.isFinite(maxZoom) ? Math.min(desiredZoom, maxZoom) : desiredZoom;
        map.flyTo(partnerLatLng, targetZoom, { animate: true, duration: 0.7 });
      });
    };

    for (const p of arr) {
      const ep = getEndpoints(p);
      if (!ep) continue;
      const [x1, y1, x2, y2] = ep;
      const entryLL = toLL(x1 + 0.5, y1 + 0.5);
      const exitLL  = toLL(x2 + 0.5, y2 + 0.5);
      makePortal(entryLL, exitLL);
      if (p?.dir !== 'one') makePortal(exitLL, entryLL);
      else makePortal(exitLL, null);
    }
  }

  function renderPortalLabels(arr) {
    for (const item of arr) {
      if (!isLabelItem(item)) continue;
      const { name, x, y } = item;
      makeLabel(x, y, name, 'portal').addTo(portalsLblFG);
    }
  }

  function renderPortals(ps) {
    if (!Array.isArray(ps)) return;
    const portalPairs = [];
    portalLabelItems = [];
    for (const it of ps) {
      if (getEndpoints(it)) portalPairs.push(it);
      else if (isLabelItem(it)) portalLabelItems.push(it);
    }
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

  function renderCrimSpawns(arr) {
    crimFG.clearLayers();
    for (const item of arr || []) {
      if (!item || typeof item.name !== 'string') continue;
      const { x, y } = item;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
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
  const ZONE_BOSS_LEVEL = 105;
  const ZONE_DIFFICULTY_STEPS = [
    { limit: 20,  bg: '#4ade80', border: '#15803d', text: '#04210f' }, // entry
    { limit: 40,  bg: '#a3e635', border: '#3f6212', text: '#1f2f0c' }, // low
    { limit: 60,  bg: '#facc15', border: '#b45309', text: '#301d04' }, // mid
    { limit: 80,  bg: '#f97316', border: '#c2410c', text: '#2b1003' }, // high
    { limit: ZONE_BOSS_LEVEL - 1, bg: '#ef4444', border: '#991b1b', text: '#fff' }, // very high
    { limit: Infinity, bg: '#b91c1c', border: '#7f1d1d', text: '#fff', skull: true } // bosses
  ];

  function formatZoneLevels(levels) {
    if (!levels) return '';
    const min = Number.isFinite(levels.min) ? levels.min : null;
    const max = Number.isFinite(levels.max) ? levels.max : null;
    if (min !== null && max !== null) return min === max ? `${min}` : `${min}-${max}`;
    if (min !== null) return `${min}+`;
    if (max !== null) return `≤${max}`;
    return '';
  }

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

  function zoneMaxLevel(levels) {
    if (!levels) return null;
    const vals = [];
    if (Number.isFinite(levels.min)) vals.push(levels.min);
    if (Number.isFinite(levels.max)) vals.push(levels.max);
    return vals.length ? Math.max(...vals) : null;
  }

  function zoneDifficultyStyle(level) {
    if (!Number.isFinite(level)) return ZONE_DIFFICULTY_STEPS[0];
    for (const step of ZONE_DIFFICULTY_STEPS) {
      if (level <= step.limit) return step;
    }
    return ZONE_DIFFICULTY_STEPS[ZONE_DIFFICULTY_STEPS.length - 1];
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

  // -------- Layer toggles --------
  function setLayerVisible(layer, on) {
    if (on && !map.hasLayer(layer)) map.addLayer(layer);
    if (!on && map.hasLayer(layer)) map.removeLayer(layer);
    rerunCollision();
  }

  pillMonsters?.addEventListener('click', () => {
    const on = !isOn(pillMonsters);
    setPill(pillMonsters, on);
    setLayerVisible(chunkFG, on);
    if (on) {
      const zoomAdjusted = ensureMonstersZoom();
      if (zoomAdjusted) map.once('zoomend', refreshChunkLayer);
      else refreshChunkLayer();
    } else {
      chunkFG.clearLayers();
      chunkTiles.clear();
    }
  });

  pillTowns?.addEventListener('click', () => {
    const on = !isOn(pillTowns);
    setPill(pillTowns, on);
    setLayerVisible(towns, on);
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

  // -------- Search (affects towns/portal labels + chunk labels) --------
  const applySearch = debounce(() => {
    const q = (searchInput?.value || '').trim();
    currentSearchRegex = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;

    const markerGroups = [towns, portalsLblFG, poisFG];

    // reset
    markerGroups.forEach(g => g.eachLayer(layer => {
      const el = layer.getElement && layer.getElement(); if (!el) return;
      const span = el.querySelector('span.n'); if (span) span.classList.remove('match');
      el.style.display = ''; el.style.visibility = '';
      if (layer.setZIndexOffset) layer.setZIndexOffset(0);
    }));

    if (currentSearchRegex) {
      markerGroups.forEach(g => g.eachLayer(layer => {
        const el = layer.getElement && layer.getElement(); if (!el) return;
        const span = el.querySelector('span.n'); if (!span) return;
        const ok = currentSearchRegex.test(span.textContent || '');
        if (ok) {
          span.classList.add('match');
          if (layer.setZIndexOffset) layer.setZIndexOffset(MATCH_ZINDEX_OFFSET);
        } else {
          el.style.display = 'none';
        }
      }));
    }

    refreshChunkLayer();
    rerunCollision();
  }, 120);
  searchInput?.addEventListener('input', applySearch);

  // -------- Image/map load --------
  const baseImg = new Image();
  baseImg.src = IMG_PATH;
  baseImg.onload = () => {
    IMG_W = baseImg.naturalWidth || baseImg.width; // fallback for older engines
    IMG_H = baseImg.naturalHeight;

    const bounds = [[0, 0], [IMG_H, IMG_W]];
    const overlay = L.imageOverlay(IMG_PATH, bounds, { className: 'map-image', interactive: false }).addTo(map);
    map.fitBounds(bounds, { animate: false });
    const minZ = map.getBoundsZoom(bounds, true);
    map.setMinZoom(minZ - ZOOM_OUT_EXTRA);
    map.setMaxZoom(minZ + 6);
    map.setZoom(minZ);

    // final mapping (apply Y flip if requested)
    toLL = INVERT_Y ? (x, y) => L.latLng(IMG_H - y, x)
                    : (x, y) => L.latLng(y, x);

    overlay.once('load', () => {
      const el = overlay.getElement();
      if (!el) return;
      el.style.textRendering = 'optimizeLegibility';
      el.style.imageRendering = 'pixelated';
    });

    Promise.all([
      fetch(DATA.towns).then(r => r.json()).catch(() => []),
      fetch(DATA.portals).then(r => r.json()).catch(() => []),
      fetch(DATA.encounters).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(DATA.caves).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(DATA.zones).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(DATA.pois).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(DATA.crim).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(DATA.monsterLvls).then(r => r.ok ? r.json() : null).catch(() => null)
    ]).then(([ts, portalsJson, enc, caves, zonesJson, poisJson, crimJson, monsterLvlJson]) => {
      // Towns (ON by default)
      window.__townDataCache = Array.isArray(ts) ? ts : [];
      for (const it of window.__townDataCache) {
        const { name, x, y } = it || {};
        if (typeof x !== 'number' || typeof y !== 'number' || !name) continue;
        makeLabel(x, y, name, 'town').addTo(towns);
      }

      // Portals (build once; layers OFF until toggled)
      renderPortals(portalsJson);

      // Encounters (Monsters)
      if (enc && typeof enc === 'object') {
        encountersIndex = new Map(Object.entries(enc));
      }

      // Caves (build once; layer OFF until toggled)
      if (Array.isArray(caves)) renderCaves(caves);
      else if (caves && typeof caves === 'object' && Array.isArray(caves.items)) renderCaves(caves.items);

      // Zones (build once; layer OFF until toggled)
      const zoneList = Array.isArray(zonesJson?.zones) ? zonesJson.zones
        : (Array.isArray(zonesJson) ? zonesJson : null);
      if (zoneList) renderZones(zoneList);

      // POIs (build once; layer OFF until toggled)
      window.__poiDataCache = Array.isArray(poisJson) ? poisJson : [];
      renderPois(window.__poiDataCache);

      // Crim spawns
      if (Array.isArray(crimJson)) renderCrimSpawns(crimJson);

      // Monster levels lookup
      if (monsterLvlJson && typeof monsterLvlJson === 'object') {
        monsterLevels = new Map();
        for (const [name, lvl] of Object.entries(monsterLvlJson)) {
          const normalized = normalizeMonsterName(name);
          if (!normalized) continue;
          const num = Number(lvl);
          if (!Number.isFinite(num)) continue;
          monsterLevels.set(normalized, num);
        }
      } else {
        monsterLevels = null;
      }

      // Set initial pill states
      setPill(pillTowns, true);
      setPill(pillMonsters, false);
      setPill(pillPortals, true);
      setPill(pillCaves, true);
      setPill(pillPois, true);
      setPill(pillCrim, false);
      setPill(pillZones, false);
      setLayerVisible(portalsLblFG, true);
      setLayerVisible(portalLinesFG, true);
      setLayerVisible(cavesFG, true);
      const candidates = vibeTargets();
      const randomSpot = randomArrayItem(candidates);
      if (randomSpot) {
        map.setView(toLL(randomSpot.x, randomSpot.y), map.getZoom(), { animate: false });
      }

      refreshChunkLayer(); // no-op until Monsters ON
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

  // -------- Measure (unchanged) --------
  let measuring = false;
  let poly = null,  verts = [], dotMarkers = [];
  const btnMeasure = $('#btnMeasure');
  const btnClear   = $('#btnClear');
  const stats      = $('#measureStats');
  const tilesPerSecond = 5;

  function snapLL(ll) { return L.latLng(Math.round(ll.lat), Math.round(ll.lng)); }
  function cheb(a, b){ return Math.max(Math.abs(a.lat - b.lat), Math.abs(a.lng - b.lng)); }
  function tilesLen(a){ let n=0; for (let i=1; i<a.length; i++) n += cheb(a[i-1], a[i]); return n; }
  function fmtTime(sec){ if (sec<60) return `${sec.toFixed(1)}s`; let s=Math.round(sec), h=Math.floor(s/3600); s%=3600; let m=Math.floor(s/60), r=s%60; const out=[]; if(h) out.push(`${h}h`); if(m) out.push(`${m}m`); if(r||(!h&&!m)) out.push(`${r}s`); return out.join(' '); }
  function updateStats(){ const t = tilesLen(verts), secs = t / tilesPerSecond; if (stats) stats.textContent = `Time: ${fmtTime(secs)} (${t} tiles)`; }
  function startMeasure(){ measuring=true; btnMeasure?.classList.add('active'); map.doubleClickZoom.disable(); verts=[]; if (poly){ routes.removeLayer(poly); poly=null; } for (const d of dotMarkers){ routes.removeLayer(d); } dotMarkers=[]; updateStats(); }
  function finishMeasure(){ measuring=false; btnMeasure?.classList.remove('active'); map.doubleClickZoom.enable(); }
  function toggleMeasure(){ measuring ? finishMeasure() : startMeasure(); }
  btnMeasure?.addEventListener('click', toggleMeasure);
  btnClear  ?.addEventListener('click', () => { verts=[]; if (poly){ routes.removeLayer(poly); poly=null; } for (const d of dotMarkers){ routes.removeLayer(d); } dotMarkers=[]; updateStats(); });
  map.on('click', e => {
    if (!measuring) return;
    const ll = snapLL(e.latlng); verts.push(ll);
    const dot = L.marker(ll, { pane:'routes', interactive:false, keyboard:false, icon: L.divIcon({ className: 'vertex' }) });
    dot.addTo(routes);
    dotMarkers.push(dot);
    if (!poly) { poly = L.polyline(verts, { color:'#4cc9f0', weight:2, opacity:0.9, pane:'routes' }).addTo(routes); }
    else       { poly.setLatLngs(verts); }
    updateStats();
  });
  map.on('dblclick', () => { if (measuring) finishMeasure(); });
  window.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== searchInput){ e.preventDefault(); searchInput.focus(); searchInput.select(); }
    else if (e.key === 'Escape' && measuring){ finishMeasure(); }
  });
  btnVibeOut?.addEventListener('click', () => {
    if (btnVibeOut.classList.contains('active')) {
      btnVibeOut.classList.remove('active');
      stopVibeLoop();
    } else {
      btnVibeOut.classList.add('active');
      startVibeLoop();
    }
  });

  // -------- Elite (simple rectangle outline) --------
  const btnEliteShow  = $('#btnEliteShow');
  const btnEliteClear = $('#btnEliteClear');
  let   eliteRing = null;

  function drawEliteAt(x, y) {
    const [gx, gy] = toGameXY(L.latLng(y, x));
    const cx = Math.floor(gx / CHUNK_SIZE), cy = Math.floor(gy / CHUNK_SIZE);
    const R  = 10; // 21×21
    const left   = (cx - R) * CHUNK_SIZE, top    = (cy - R) * CHUNK_SIZE;
    const right  = (cx + R + 1) * CHUNK_SIZE - 1;
    const bottom = (cy + R + 1) * CHUNK_SIZE - 1;
    const b = L.latLngBounds(toLL(left, top), toLL(right + 1, bottom + 1));
    const ring = [b.getNorthWest(), b.getNorthEast(), b.getSouthEast(), b.getSouthWest(), b.getNorthWest()];
    if (!eliteRing) eliteRing = L.polygon(ring, { color:'#4cc9f0', weight:2, fillOpacity:0, pane:'elite' }).addTo(eliteFG);
    else            eliteRing.setLatLngs(ring);
  }

  btnEliteShow?.addEventListener('click', () => {
    btnEliteShow.classList.add('active');
    const handler = ev => { drawEliteAt(ev.latlng.lng, ev.latlng.lat); map.off('click', handler); btnEliteShow.classList.remove('active'); };
    map.on('click', handler);
  });
  btnEliteClear?.addEventListener('click', () => { if (eliteRing){ eliteFG.removeLayer(eliteRing); eliteRing = null; } });

  // -------- Collision hider (towns + portal labels) --------
  function markerPriority(spanEl) {
    let score = 1;
    if (spanEl.classList.contains('portal')) score = 2;
    if (spanEl.classList.contains('poi'))    score = 2;
    if (spanEl.classList.contains('town'))   score = 3;
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
        if (el.style.display === 'none'){ el.style.attach = ''; el.style.visibility = 'hidden'; return; }
        const span = el.querySelector('span.n');  if (!span) return;

        const pt = map.latLngToLayerPoint(m.getLatLng());
        const w  = el.offsetWidth  || (span.textContent.length * 7 + 6);
        const h  = el.offsetHeight || (span.classList.contains('town') ? 24 : 14);
        const r  = { x: pt.x, y: pt.y, w, h, score: markerPriority(span) };

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
                // prefer higher score (towns > portals, matches > non-matches)
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

    consider(towns);
    consider(portalsLblFG);
  }

  // -------- Map change hooks --------
  map.on('zoomend',  () => { refreshChunkLayerDebounced(); rerunCollision(); });
  map.on('moveend',  () => { refreshChunkLayerDebounced(); rerunCollision(); });

})();
