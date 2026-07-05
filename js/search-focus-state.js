export function searchTypeForRun({ term, exact, currentSearchType, entry }) {
  if (!String(term || '').trim()) return null;
  if (currentSearchType) return currentSearchType;
  if (!exact) return null;
  return entry?.type || null;
}

export function searchEntryFocusTarget({ entry, currentZoom, minZoom, maxZoom, duration = 0.8 }) {
  if (!entry || entry.type === 'monster') return { kind: 'matches' };
  const { x, y } = entry;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { kind: 'matches' };

  const desired = Number.isFinite(minZoom) ? minZoom + 2 : currentZoom;
  const baseZoom = Math.max(currentZoom, desired);
  const zoom = Number.isFinite(maxZoom) ? Math.min(baseZoom, maxZoom) : baseZoom;
  return { kind: 'point', x, y, zoom, duration };
}

export function searchMatchCount(names, searchRegex) {
  if (!searchRegex || !Array.isArray(names) || !names.length) return 0;
  let hits = 0;
  for (const name of names) {
    if (typeof name !== 'string') continue;
    if (regexTest(searchRegex, name)) hits++;
  }
  return hits;
}

export function bestSearchClusterCenter({ encountersIndex, searchRegex, radius }) {
  if (!searchRegex || !encountersIndex || typeof encountersIndex.entries !== 'function') return null;
  const counts = new Map();
  for (const [key, arr] of encountersIndex.entries()) {
    const matches = searchMatchCount(arr, searchRegex);
    if (!matches) continue;
    counts.set(key, matches);
  }
  if (!counts.size) return null;

  let best = null;
  for (const key of counts.keys()) {
    const [cxRaw, cyRaw] = key.split(',').map(n => Number(n));
    if (!Number.isFinite(cxRaw) || !Number.isFinite(cyRaw)) continue;
    let sum = 0;
    let wx = 0;
    let wy = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const neighborKey = `${cxRaw + dx},${cyRaw + dy}`;
        const val = counts.get(neighborKey);
        if (!val) continue;
        sum += val;
        wx += (cxRaw + dx) * val;
        wy += (cyRaw + dy) * val;
      }
    }
    if (!best || sum > best.sum) {
      best = { sum, wx, wy };
    }
  }
  if (!best || best.sum <= 0) return null;
  return { cx: best.wx / best.sum, cy: best.wy / best.sum };
}

export function searchLabelZoom({ minZoom, maxZoom, currentZoom, neededPx, chunkScreenSizeAtZoom }) {
  const minZ = Number.isFinite(minZoom) ? minZoom : currentZoom;
  const maxZ = Number.isFinite(maxZoom) ? maxZoom : currentZoom;
  for (let z = minZ; z <= maxZ; z++) {
    const [cw, ch] = chunkScreenSizeAtZoom(z);
    if (cw >= neededPx && ch >= neededPx) return z;
  }
  return maxZ;
}

function regexTest(regex, value) {
  if (typeof regex.test !== 'function') return false;
  regex.lastIndex = 0;
  return regex.test(value);
}
