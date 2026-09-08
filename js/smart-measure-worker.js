import { decodeNavigationGrid } from './navigation-grid.js';
import { decodeNavigationHierarchy } from './navigation-hierarchy.js';
import { findSmartWalkingPath } from './hierarchical-pathfinding.js';

const base = new URL('../data/navigation/', import.meta.url);
let manifestPromise = null, activeId = null;
const grids = new Map();
const hierarchies = new Map();
async function loadHierarchy(floor, grid) {
  const manifest = await manifestPromise, info = manifest.floors[floor], hierarchy = info.hierarchy;
  if (!hierarchy || hierarchy.gridSha256 !== info.sha256) throw new Error('Hierarchy version mismatch');
  if (!hierarchies.has(floor)) {
    const promise = fetch(new URL(`${hierarchy.file}?v=${hierarchy.sha256}`, base)).then(async response => {
      if (!response.ok) throw new Error('Navigation hierarchy unavailable');
      const buffer = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== hierarchy.sha256) throw new Error('Hierarchy data version mismatch');
      if (hierarchy.encoding !== 'gzip') throw new Error('Invalid hierarchy encoding');
      const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
      const decoded = await new Response(stream).arrayBuffer();
      if (decoded.byteLength !== hierarchy.decodedBytes) throw new Error('Hierarchy size mismatch');
      return decodeNavigationHierarchy(decoded, grid);
    }).catch(error => { hierarchies.delete(floor); throw error; });
    hierarchies.set(floor, promise);
  }
  return hierarchies.get(floor);
}
async function loadGrid(floor) {
  if (!manifestPromise) manifestPromise = fetch(new URL('manifest.json', base), { cache: 'no-cache' }).then(response => {
    if (!response.ok) throw new Error('Navigation manifest unavailable');
    return response.json();
  }).catch(error => { manifestPromise = null; throw error; });
  const manifest = await manifestPromise;
  const info = manifest.floors[floor];
  if (manifest.version !== 1 || !info || !['overworld', 'underground'].includes(floor)) throw new Error('Invalid floor');
  if (!grids.has(floor)) {
    const promise = fetch(new URL(`${info.file}?v=${info.sha256}`, base)).then(async response => {
      if (!response.ok) throw new Error('Navigation grid unavailable');
      const buffer = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== info.sha256) throw new Error('Navigation data version mismatch');
      const grid = decodeNavigationGrid(buffer);
      if (grid.width !== info.width || grid.height !== info.height) throw new Error('Navigation size mismatch');
      return { grid, offset: info.offsetX };
    }).catch(error => { grids.delete(floor); throw error; });
    grids.set(floor, promise);
  }
  return grids.get(floor);
}

self.onmessage = async ({ data }) => {
  if (data.type === 'cancel') {
    if (activeId === data.id) activeId = null;
    return;
  }
  const { id, floor, points } = data;
  activeId = id;
  const cancelled = () => activeId !== id;
  try {
    const { grid, offset } = await loadGrid(floor);
    if (cancelled()) return;
    const local = points.map(point => ({ x: point.x - offset, y: point.y }));
    if (!local.length || local.some(point => !grid.component(point.x, point.y))) {
      self.postMessage({ id, status: 'blocked' }); return;
    }
    const segments = [];
    for (let i = 1; i < local.length; i++) {
      const result = await findSmartWalkingPath(grid, () => loadHierarchy(floor, grid), local[i - 1], local[i], { cancelled });
      if (cancelled()) return;
      if (result.status !== 'ok') { self.postMessage({ id, status: result.status }); return; }
      segments.push({ steps: result.steps, path: result.path.map(point => ({ x: point.x + offset, y: point.y })) });
    }
    if (!cancelled()) self.postMessage({ id, status: 'ok', segments });
  } catch {
    if (!cancelled()) self.postMessage({ id, status: 'unavailable' });
  }
};
