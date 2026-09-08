const pause = () => new Promise(resolve => setTimeout(resolve, 0));

// Remove only collinear steps: no geometric smoothing across blocked terrain.
export function compressPath(points) {
  if (points.length < 3) return points;
  const result = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1];
    if (b.x - a.x !== c.x - b.x || b.y - a.y !== c.y - b.y) result.push(b);
  }
  result.push(points[points.length - 1]);
  return result;
}

export function directWalkingPath(grid, start, end) {
  const path = [start];
  let x = start.x, y = start.y;
  while (x !== end.x || y !== end.y) {
    const dx = Math.sign(end.x - x), dy = Math.sign(end.y - y);
    if (!grid.walkable(x + dx, y + dy) || (dx && dy && (!grid.walkable(x + dx, y) || !grid.walkable(x, y + dy)))) return null;
    x += dx; y += dy; path.push({ x, y });
  }
  return path;
}

export async function findWalkingPath(grid, start, end, {
  cancelled = () => false, maxNodes = 400000, maxMs = 4000, yieldEvery = 2048
} = {}) {
  const started = performance.now();
  if (cancelled()) return { status: 'cancelled' };
  if (maxMs <= 0) return { status: 'limit' };
  const first = grid.component(start.x, start.y), last = grid.component(end.x, end.y);
  if (!first || !last) return { status: 'blocked' };
  if (first !== last) return { status: 'unreachable' };
  const canStep = (x, y, dx, dy) => grid.walkable(x + dx, y + dy)
    && (!dx || !dy || (grid.walkable(x + dx, y) && grid.walkable(x, y + dy)));
  // Open-ground routes need no search allocation.
  const direct = directWalkingPath(grid, start, end);
  if (direct) return { status: 'ok', path: compressPath(direct), steps: direct.length - 1, expanded: 0 };

  const width = grid.width;
  const ids = new Uint32Array(maxNodes), costs = new Uint32Array(maxNodes), heuristic = new Uint32Array(maxNodes);
  const parents = new Int32Array(maxNodes), heap = new Uint32Array(maxNodes), slots = new Int32Array(maxNodes);
  const nodes = new Map();
  let count = 0, heapSize = 0, expanded = 0;
  const better = (a, b) => costs[a] + heuristic[a] < costs[b] + heuristic[b]
    || (costs[a] + heuristic[a] === costs[b] + heuristic[b] && heuristic[a] < heuristic[b]);
  const swap = (a, b) => {
    const item = heap[a]; heap[a] = heap[b]; heap[b] = item;
    slots[heap[a]] = a; slots[heap[b]] = b;
  };
  const up = index => {
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (!better(heap[index], heap[parent])) break;
      swap(index, parent); index = parent;
    }
  };
  const add = (id, g, parent, h) => {
    const index = count++;
    ids[index] = id; costs[index] = g; parents[index] = parent; heuristic[index] = h;
    nodes.set(id, index); slots[index] = heapSize; heap[heapSize++] = index; up(heapSize - 1);
  };
  add(start.y * width + start.x, 0, -1, Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y)));
  const destination = end.y * width + end.x;
  while (heapSize) {
    if (expanded % yieldEvery === 0) {
      if (cancelled()) return { status: 'cancelled' };
      if (performance.now() - started > maxMs) return { status: 'limit' };
      if (expanded) await pause();
      if (cancelled()) return { status: 'cancelled' };
    }
    const node = heap[0];
    heapSize--;
    if (heapSize) {
      heap[0] = heap[heapSize]; slots[heap[0]] = 0;
      let i = 0;
      while (i * 2 + 1 < heapSize) {
        let child = i * 2 + 1;
        if (child + 1 < heapSize && better(heap[child + 1], heap[child])) child++;
        if (!better(heap[child], heap[i])) break;
        swap(i, child); i = child;
      }
    }
    slots[node] = -1;
    if (ids[node] === destination) {
      const path = [];
      for (let n = node; n !== -1; n = parents[n]) path.push({ x: ids[n] % width, y: Math.floor(ids[n] / width) });
      path.reverse();
      return { status: 'ok', path: compressPath(path), steps: costs[node], expanded };
    }
    expanded++;
    const cx = ids[node] % width, cy = Math.floor(ids[node] / width);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || !canStep(cx, cy, dx, dy)) continue;
      const nx = cx + dx, ny = cy + dy, id = ny * width + nx, g = costs[node] + 1;
      const existing = nodes.get(id);
      if (existing !== undefined) {
        // Chebyshev is consistent for unit-cost eight-way steps, so closed
        // nodes never need reopening.
        if (slots[existing] < 0 || g >= costs[existing]) continue;
        costs[existing] = g; parents[existing] = node; up(slots[existing]);
      } else {
        if (count >= maxNodes) return { status: 'limit' };
        add(id, g, node, Math.max(Math.abs(end.x - nx), Math.abs(end.y - ny)));
      }
    }
  }
  return { status: 'unreachable' };
}
