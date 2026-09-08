// Unit-cost eight-way flood fill inside one cluster. Diagonals require both
// orthogonal tiles, exactly like the full-grid walking search.
export function clusterBounds(grid, size, point) {
  const x = Math.floor(point.x / size) * size, y = Math.floor(point.y / size) * size;
  return { x, y, width: Math.min(size, grid.width - x), height: Math.min(size, grid.height - y) };
}

export function clusterFlood(grid, bounds, start) {
  const { x: ox, y: oy, width, height } = bounds, count = width * height;
  const distances = new Int32Array(count).fill(-1), parents = new Int32Array(count).fill(-1);
  const queue = new Uint32Array(count), mask = new Uint8Array(count);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) mask[y * width + x] = grid.walkable(ox + x, oy + y);
  const source = (start.y - oy) * width + start.x - ox;
  let head = 0, tail = 0;
  if (mask[source]) { queue[tail++] = source; distances[source] = 0; }
  while (head < tail) {
    const id = queue[head++], x = id % width, y = Math.floor(id / width);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy, next = ny * width + nx;
      if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= width || ny >= height || !mask[next] || distances[next] !== -1) continue;
      if (dx && dy && (!mask[y * width + nx] || !mask[ny * width + x])) continue;
      distances[next] = distances[id] + 1; parents[next] = id; queue[tail++] = next;
    }
  }
  const index = point => (point.y - oy) * width + point.x - ox;
  return {
    distance: point => distances[index(point)],
    path(point) {
      let id = index(point);
      if (distances[id] < 0) return null;
      const path = [];
      while (id !== -1) { path.push({ x: ox + id % width, y: oy + Math.floor(id / width) }); id = parents[id]; }
      return path.reverse();
    }
  };
}
