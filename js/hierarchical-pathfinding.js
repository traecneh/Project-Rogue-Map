import { clusterBounds, clusterFlood } from './navigation-clusters.js';
import { compressPath, directWalkingPath, findWalkingPath } from './smart-pathfinding.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const distance = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export async function findHierarchicalPath(grid, hierarchy, start, end, {
  cancelled = () => false, maxMs = 4000, yieldEvery = 256, yieldMs = 8
} = {}) {
  const started = performance.now();
  let lastYield = started;
  const checkpoint = async () => {
    if (performance.now() - lastYield >= yieldMs) { await pause(); lastYield = performance.now(); }
  };
  const status = () => cancelled() ? 'cancelled' : performance.now() - started >= maxMs ? 'limit' : null;
  if (status()) return { status: status() };
  const first = grid.component(start.x, start.y), last = grid.component(end.x, end.y);
  if (!first || !last) return { status: 'blocked' };
  if (first !== last) return { status: 'unreachable' };
  const { size, count, offsets, destinations, costs, point, cluster, members } = hierarchy;
  const startFlood = clusterFlood(grid, clusterBounds(grid, size, start), start);
  const endFlood = clusterFlood(grid, clusterBounds(grid, size, end), end);
  const ends = new Map(members(end).map(id => [id, endFlood.distance(point(id))]).filter(([, cost]) => cost >= 0));
  const best = new Float64Array(count + 2).fill(Infinity), parents = new Int32Array(count + 2).fill(-1);
  const closed = new Uint8Array(count + 2), heap = [];
  const source = count, target = count + 1;
  const position = id => id === source ? start : id === target ? end : point(id);
  const better = (a, b) => a.f < b.f || (a.f === b.f && a.g > b.g);
  const push = (id, g, parent) => {
    if (g >= best[id] || closed[id]) return;
    best[id] = g; parents[id] = parent;
    const item = { id, g, f: g + distance(position(id), end) };
    let i = heap.length; heap.push(item);
    while (i > 0) {
      const p = (i - 1) >>> 1;
      if (!better(item, heap[p])) break;
      heap[i] = heap[p]; i = p;
    }
    heap[i] = item;
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && better(heap[child + 1], heap[child])) child++;
        if (!better(heap[child], last)) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = last;
    }
    return top;
  };
  push(source, 0, -1);
  let expanded = 0;
  while (heap.length) {
    if (expanded % yieldEvery === 0) {
      if (expanded) await checkpoint();
      if (status()) return { status: status() };
    }
    const { id, g } = pop();
    if (closed[id] || g !== best[id]) continue;
    if (id === target) break;
    closed[id] = 1; expanded++;
    if (id === source) {
      for (const portal of members(start)) {
        const cost = startFlood.distance(point(portal));
        if (cost >= 0) push(portal, cost, source);
      }
      if (cluster(start) === cluster(end)) {
        const cost = startFlood.distance(end);
        if (cost >= 0) push(target, cost, source);
      }
    } else {
      for (let edge = offsets[id]; edge < offsets[id + 1]; edge++) push(destinations[edge], g + costs[edge], id);
      if (ends.has(id)) push(target, g + ends.get(id), id);
    }
  }
  // The hierarchy preserves connectivity. A missing chain means invalid data,
  // not proof that two tiles in the same connected component are unreachable.
  if (parents[target] === -1) return { status: 'unavailable' };
  const chain = [];
  for (let id = target; id !== -1; id = parents[id]) chain.push(position(id));
  chain.reverse();
  const raw = [start];
  for (let i = 1; i < chain.length; i++) {
    if (i % 8 === 0) await checkpoint();
    if (status()) return { status: status() };
    const a = chain[i - 1], b = chain[i];
    let path;
    if (cluster(a) !== cluster(b)) {
      // Offline boundary edges are cardinal, adjacent, and walkable.
      if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) return { status: 'unavailable' };
      path = [a, b];
    } else {
      // Refine only the selected local edges; use the existing exact tile A*.
      const bounds = clusterBounds(grid, size, a);
      const inside = (x, y) => x >= bounds.x && y >= bounds.y && x < bounds.x + bounds.width && y < bounds.y + bounds.height;
      const localGrid = { width: grid.width, walkable: (x, y) => inside(x, y) && grid.walkable(x, y), component: (x, y) => inside(x, y) ? grid.component(x, y) : 0 };
      const result = await findWalkingPath(localGrid, a, b, { cancelled, maxNodes: size * size, maxMs: Math.max(0, maxMs - (performance.now() - started)) });
      if (result.status !== 'ok') return result;
      path = [];
      for (let j = 1; j < result.path.length; j++) {
        let { x, y } = result.path[j - 1];
        const to = result.path[j], dx = Math.sign(to.x - x), dy = Math.sign(to.y - y);
        while (x !== to.x || y !== to.y) { path.push({ x, y }); x += dx; y += dy; }
      }
      path.push(b);
    }
    for (let j = 1; j < path.length; j++) raw.push(path[j]);
  }
  // Remove portal-induced stair steps using only valid grid walks. This never
  // smooths a line across obstacles or reports a shorter geometric distance.
  const refined = [start];
  for (let i = 0, checks = 0; i < raw.length - 1;) {
    if (++checks % 32 === 0) { await checkpoint(); if (status()) return { status: status() }; }
    let next = i + 1, shortcut = null;
    for (let j = Math.min(raw.length - 1, i + 128); j > i + 1; j -= 4) {
      shortcut = directWalkingPath(grid, raw[i], raw[j]);
      if (shortcut) { next = j; break; }
    }
    if (shortcut) for (let j = 1; j < shortcut.length; j++) refined.push(shortcut[j]);
    else refined.push(raw[next]);
    i = next;
  }
  if (status()) return { status: status() };
  return { status: 'ok', path: compressPath(refined), steps: refined.length - 1, expanded, strategy: 'hierarchical' };
}

export async function findSmartWalkingPath(grid, loadHierarchy, start, end, { cancelled = () => false } = {}) {
  if (cancelled()) return { status: 'cancelled' };
  const first = grid.component(start.x, start.y), last = grid.component(end.x, end.y);
  if (!first || !last) return { status: 'blocked' };
  if (first !== last) return { status: 'unreachable' };
  const direct = directWalkingPath(grid, start, end);
  if (direct) return { status: 'ok', path: compressPath(direct), steps: direct.length - 1, expanded: 0 };
  if (distance(start, end) <= 256) {
    const local = await findWalkingPath(grid, start, end, { cancelled, maxNodes: 40000, maxMs: 500 });
    if (local.status !== 'limit') return local;
  }
  const hierarchy = await loadHierarchy();
  if (cancelled()) return { status: 'cancelled' };
  return findHierarchicalPath(grid, hierarchy, start, end, { cancelled });
}
