import { elitePreviewBounds, formatTravelTime, measureTileDistance, nearestCrimSpawn } from './map-tool-utils.js';
import { createSmartMeasureClient } from './smart-measure-client.js';

export function createMapTools({ L, map, routes, eliteFG, respawnFG, floors, chunkSize,
  getFloor, getImageHeight, toGameXY, toLL, getCrimSpawns, getCrimColor, switchFloor, panel, collapsePanel }) {
  const $ = selector => document.querySelector(selector);
  const measureButton = $('#btnMeasure'), undoButton = $('#btnMeasureUndo'), measureClear = $('#btnClear');
  const smartCheckbox = $('#measureSmart');
  const smartClient = createSmartMeasureClient();
  const eliteButton = $('#btnEliteShow'), eliteClear = $('#btnEliteClear');
  const respawnButton = $('#btnCrimRespawn'), respawnClear = $('#btnCrimRespawnClear');
  const measureHint = $('#measureHint'), eliteHint = $('#eliteHint'), respawnHint = $('#respawnHint');
  const colors = ['#c8a4ff', '#70d8dd', '#f3c969', '#f49cb8'];
  const measurements = new Map();
  const elitePositions = [];
  let mode = null, restoreDoubleClickZoom = false;
  let preview = null, respawn = null;
  let smartEnabled = true, measureBusy = false, measureMessage = '', measureJob = 0;

  const measurement = () => measurements.get(getFloor());
  const points = () => measurement()?.points || [];
  const floorPositions = () => elitePositions.filter(position => position.floor === getFloor());
  const latLng = point => toLL(point.x, point.y);
  const setText = (element, text) => { if (element) element.textContent = text; };
  function buttonState(button, active, text) {
    if (!button) return;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.textContent = text;
  }

  function updateControls() {
    buttonState(measureButton, mode === 'measure', mode === 'measure' ? 'Finish' : 'Measure');
    if (measureButton) measureButton.title = mode === 'measure' ? 'Finish this route (Esc)' : 'Start a new route (M)';
    buttonState(eliteButton, mode === 'elite', mode === 'elite' ? 'Done' : 'Add positions');
    buttonState(respawnButton, mode === 'respawn', mode === 'respawn' ? 'Cancel' : 'Find Respawn');
    if (undoButton) undoButton.disabled = points().length === 0 && !measureBusy;
    if (measureClear) measureClear.disabled = !points().length && mode !== 'measure';
    if (eliteClear) eliteClear.disabled = !elitePositions.length && mode !== 'elite';
    if (respawnClear) respawnClear.disabled = !respawn && mode !== 'respawn';
    const saved = measurement();
    const tiles = saved?.smart ? saved.segments.reduce((sum, segment) => sum + segment.steps, 0) : measureTileDistance(points());
    if (smartCheckbox) smartCheckbox.checked = smartEnabled;
    setText($('#measureStats'), `${tiles} tiles · Estimated travel time: ${formatTravelTime(tiles / 5)}`);
    setText(measureHint, measureBusy ? 'Calculating route…' : measureMessage || (mode === 'measure' ? 'Click to add points. Finish or Esc to stop.' : 'Draw a route by clicking points. M to start.'));
    measureHint?.setAttribute('aria-busy', String(measureBusy));
    setText($('#measureNote'), smartEnabled ? 'Walking route · 5 tiles/sec. Water, mountains and void are blocked.' : 'At 5 tiles/sec. Follow walkable paths when placing points.');
    setText(eliteHint, mode === 'elite' ? 'Click to add positions. Done or Esc to stop.' : 'Compare standing positions. Drag a numbered pin to move it.');
    setText(respawnHint, mode === 'respawn' ? 'Click where you might die. Underground checks its Overworld position.' : 'Pick a spot to see where you would respawn.');
    map.getContainer().classList.toggle('map-tool-selecting', mode !== null);
  }

  function removePreview() {
    if (preview) eliteFG.removeLayer(preview);
    preview = null;
  }

  function setMode(next) {
    if (next !== 'measure') {
      cancelMeasureWork();
      smartEnabled = measurement()?.smart ?? smartEnabled;
    }
    if (mode === 'measure' && restoreDoubleClickZoom) map.doubleClickZoom.enable();
    if (next === 'measure' && mode !== 'measure') {
      restoreDoubleClickZoom = map.doubleClickZoom.enabled();
      map.doubleClickZoom.disable();
    }
    mode = next;
    removePreview();
    updateControls();
  }

  function renderMeasure() {
    routes.clearLayers();
    const route = points();
    const saved = measurement();
    const line = saved?.smart ? saved.segments.flatMap((segment, index) => index ? segment.path.slice(1) : segment.path) : route;
    // Smart paths run through tile centers. Disable Leaflet's line simplifier so
    // it cannot visually cut across an obstacle at a turn or when zooming out.
    const renderPoint = point => saved?.smart ? toLL(point.x + 0.5, point.y + 0.5) : latLng(point);
    if (line.length > 1) L.polyline(line.map(renderPoint), {
      color: '#4cc9f0', weight: 2, opacity: 0.9, pane: 'routes', interactive: false,
      smoothFactor: saved?.smart ? 0 : 1
    }).addTo(routes);
    route.forEach(point => L.marker(renderPoint(point), {
      pane: 'routes', interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'vertex' })
    }).addTo(routes));
    updateControls();
  }

  function startMeasure() {
    if (mode === 'measure') return;
    cancelMeasureWork();
    measurements.set(getFloor(), { points: [], segments: [], smart: smartEnabled });
    setMode('measure');
    renderMeasure();
  }

  function cancelMeasureWork() {
    measureJob++;
    smartClient.cancel();
    measureBusy = false;
    measureMessage = '';
  }

  async function calculateMeasure(candidate, commit) {
    cancelMeasureWork();
    const job = measureJob, floor = getFloor();
    measureBusy = true;
    updateControls();
    const result = await smartClient.request(floor, candidate);
    if (job !== measureJob || floor !== getFloor()) return;
    measureBusy = false;
    if (result.status === 'ok') commit(result.segments);
    else {
      const messages = {
        blocked: 'Choose a walkable tile.',
        unreachable: 'No walking route found from the previous point.',
        limit: 'Route too complex—try a closer waypoint.',
        unavailable: 'Smart Measure could not load. Try again or turn it off.'
      };
      measureMessage = messages[result.status] || '';
      smartEnabled = measurement()?.smart ?? smartEnabled;
    }
    renderMeasure();
  }

  smartCheckbox?.addEventListener('change', () => {
    cancelMeasureWork();
    smartEnabled = smartCheckbox.checked;
    const route = points().slice();
    if (!smartEnabled || !route.length) {
      measurements.set(getFloor(), { points: route, segments: [], smart: smartEnabled });
      renderMeasure();
    } else {
      calculateMeasure(route, segments => measurements.set(getFloor(), { points: route, segments, smart: true }));
    }
  });

  function pointOnFloor(ll, floor = getFloor(), clampPosition = false) {
    const config = floors[floor], height = getImageHeight();
    if (!height) return null;
    if (!clampPosition && (ll.lng < config.minX || ll.lng >= config.maxX || ll.lat < 0 || ll.lat > height)) return null;
    const [x, y] = toGameXY(ll);
    return { x: Math.max(config.minX, Math.min(config.maxX - 1, x)), y: Math.max(0, Math.min(height - 1, y)) };
  }

  function eliteBounds(position) {
    const bounds = elitePreviewBounds({ ...position, ...floors[position.floor], height: getImageHeight(), chunkSize });
    return L.latLngBounds(toLL(bounds.left, bounds.top), toLL(bounds.right, bounds.bottom));
  }

  function renderPositionList() {
    const list = $('#elitePositions');
    if (!list) return;
    list.innerHTML = '';
    for (const position of floorPositions()) {
      const row = document.createElement('div');
      row.className = 'elite-position-row';
      const focus = document.createElement('button');
      focus.type = 'button';
      focus.className = 'elite-position-focus';
      focus.textContent = `${position.id} · X ${position.x}, Y ${position.y}`;
      focus.title = `Show position ${position.id} on ${floors[position.floor].label}`;
      focus.style.setProperty('--position-color', position.color);
      focus.addEventListener('click', () => {
        setMode(null);
        map.setView(latLng(position), map.getZoom(), { animate: false });
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'elite-position-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove elite position ${position.id}`);
      remove.addEventListener('click', () => {
        setMode(null);
        elitePositions.splice(elitePositions.indexOf(position), 1);
        elitePositions.forEach((remaining, index) => {
          remaining.id = index + 1;
          remaining.color = colors[index % colors.length];
        });
        renderElite();
        updateControls();
      });
      row.appendChild(focus);
      row.appendChild(remove);
      list.appendChild(row);
    }
    const count = floorPositions().length;
    setText($('#eliteCount'), elitePositions.length ? `${count} on ${floors[getFloor()].label} · ${elitePositions.length} total` : '');
  }

  function renderElite() {
    eliteFG.clearLayers();
    preview = null;
    for (const position of floorPositions()) {
      const area = L.rectangle(eliteBounds(position), {
        pane: 'elite', color: position.color, weight: 2, fillOpacity: 0.035, interactive: false
      }).addTo(eliteFG);
      const marker = L.marker(latLng(position), {
        pane: 'elite', draggable: true, bubblingMouseEvents: false,
        title: `Elite position ${position.id} — drag to move`, alt: `Elite position ${position.id}`,
        icon: L.divIcon({ className: 'elite-position-pin', iconSize: [44, 44], iconAnchor: [22, 22],
          html: `<span style="--position-color:${position.color}">${position.id}</span>` })
      }).addTo(eliteFG);
      marker.on('dragstart', () => setMode(null));
      marker.on('drag', () => {
        Object.assign(position, pointOnFloor(marker.getLatLng(), position.floor, true));
        area.setBounds(eliteBounds(position));
      });
      marker.on('dragend', () => {
        marker.setLatLng(latLng(position));
        renderPositionList();
      });
    }
    renderPositionList();
  }

  function renderRespawn() {
    respawnFG.clearLayers();
    if (!respawn || getFloor() !== 'overworld') return;
    const color = getCrimColor();
    L.polyline([latLng(respawn.start), latLng(respawn.end)], {
      color, weight: 2, opacity: 0.9, pane: 'routes', interactive: false
    }).addTo(respawnFG);
    for (const [kind, point] of [['start', respawn.start], ['end', respawn.end]]) {
      L.marker(latLng(point), {
        pane: 'elite', interactive: false, keyboard: false,
        title: kind === 'start' ? 'Selected location' : 'Respawn location',
        icon: L.divIcon({ className: `respawn-point respawn-point-${kind}`, iconSize: [14, 14], iconAnchor: [7, 7],
          html: `<span style="--respawn-color:${color}"></span>` })
      }).addTo(respawnFG);
    }
  }

  function fitRespawn(start, end, allowCollapse = true) {
    const size = map.getSize(), mapRect = map.getContainer().getBoundingClientRect();
    const panelRect = panel?.getBoundingClientRect();
    let left = 24, top = 24;
    if (panelRect?.width) {
      const panelRight = Math.max(0, panelRect.right - mapRect.left + 24);
      const panelBottom = Math.max(0, panelRect.bottom - mapRect.top + 24);
      // Use the larger unobscured part of the map, including below a mobile panel.
      if ((size.x - panelRight) * size.y >= size.x * (size.y - panelBottom)) left = Math.min(panelRight, size.x - 48);
      else top = Math.min(panelBottom, size.y - 48);
    }
    const visible = point => {
      const pixel = map.latLngToContainerPoint(point);
      return pixel.x >= left && pixel.x <= size.x - 24 && pixel.y >= top && pixel.y <= size.y - 24;
    };
    if (visible(start) && visible(end)) return;
    map.fitBounds(L.latLngBounds(start, end), {
      paddingTopLeft: [left, top], paddingBottomRight: [24, 24], maxZoom: map.getZoom(), animate: false
    });
    // The map's minimum zoom can prevent fitting a long line into the small
    // space below a phone panel. Reveal the result without changing zoom limits.
    if (allowCollapse && (!visible(start) || !visible(end)) && !panel?.classList.contains('collapsed')) {
      collapsePanel();
      fitRespawn(start, end, false);
    }
  }

  measureButton?.addEventListener('click', () => mode === 'measure' ? setMode(null) : startMeasure());
  undoButton?.addEventListener('click', () => {
    const wasBusy = measureBusy;
    cancelMeasureWork();
    smartEnabled = measurement()?.smart ?? smartEnabled;
    // The point being calculated has not been committed yet; Undo cancels it.
    if (!wasBusy) { points().pop(); measurement()?.segments.pop(); }
    renderMeasure();
  });
  measureClear?.addEventListener('click', () => {
    cancelMeasureWork();
    if (mode === 'measure') setMode(null);
    measurements.delete(getFloor());
    renderMeasure();
  });
  eliteButton?.addEventListener('click', () => setMode(mode === 'elite' ? null : 'elite'));
  eliteClear?.addEventListener('click', () => {
    if (mode === 'elite') setMode(null);
    elitePositions.length = 0;
    renderElite();
    updateControls();
  });
  respawnButton?.addEventListener('click', () => setMode(mode === 'respawn' ? null : 'respawn'));
  respawnClear?.addEventListener('click', () => {
    if (mode === 'respawn') setMode(null);
    respawn = null;
    renderRespawn();
    updateControls();
  });

  map.on('click', event => {
    if (!mode || event.originalEvent?.detail > 1) return;
    const point = pointOnFloor(event.latlng);
    if (!point) return;
    if (mode === 'measure') {
      if (measureBusy) return;
      const route = points(), last = route[route.length - 1];
      if (last?.x === point.x && last?.y === point.y) return;
      if (smartEnabled) {
        calculateMeasure(last ? [last, point] : [point], segments => {
          measurements.set(getFloor(), { points: [...route, point], segments: [...(measurement()?.segments || []), ...segments], smart: true });
        });
      } else {
        measureMessage = '';
        route.push(point);
        measurements.set(getFloor(), { points: route, segments: [], smart: false });
        renderMeasure();
      }
    } else if (mode === 'elite') {
      const floor = getFloor();
      // A repeated click at the same spot should not stack identical previews.
      if (floorPositions().some(item => item.x === point.x && item.y === point.y)) return;
      const id = elitePositions.length + 1;
      elitePositions.push({ ...point, floor, id, color: colors[(id - 1) % colors.length] });
      renderElite();
      updateControls();
    } else {
      const start = { x: point.x - floors[getFloor()].offset, y: point.y };
      const end = nearestCrimSpawn(getCrimSpawns(), start.x, start.y);
      setMode(null);
      if (!end) {
        setText(respawnHint, 'Respawn locations are unavailable. Try reloading the map.');
        return;
      }
      if (getFloor() !== 'overworld') switchFloor('overworld', { ...start, zoom: map.getZoom() });
      respawn = { start, end };
      renderRespawn();
      fitRespawn(latLng(start), latLng(end));
      updateControls();
    }
  });
  map.on('mousemove', event => {
    if (mode !== 'elite') return;
    const point = pointOnFloor(event.latlng);
    if (!point) { removePreview(); return; }
    const bounds = eliteBounds({ ...point, floor: getFloor() });
    if (preview) preview.setBounds(bounds);
    else preview = L.rectangle(bounds, { pane: 'elite', color: colors[elitePositions.length % colors.length],
      weight: 1, dashArray: '5 5', fillOpacity: 0.02, interactive: false }).addTo(eliteFG);
  });
  map.on('mouseout dragstart zoomstart', removePreview);
  map.on('dblclick', () => { if (mode === 'measure') setMode(null); });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') { setMode(null); return; }
    const target = event.target;
    if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName)) return;
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat && event.key.toLowerCase() === 'm') {
      event.preventDefault();
      startMeasure();
    }
  });

  updateControls();
  return {
    onFloorChange() {
      setMode(null);
      smartEnabled = measurement()?.smart ?? smartEnabled;
      renderMeasure();
      renderElite();
      renderRespawn();
    }
  };
}
