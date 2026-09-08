import { clusterBounds, clusterFlood } from '../js/navigation-clusters.js';

// One crossing for every narrow opening; sample wider openings at both ends
// and at most eight tiles apart. Never merge disconnected parts of a cluster.
export function buildHierarchy(grid, size = 32, spacing = 8) {
  if (!Number.isInteger(size) || size < 2 || size > 64 || !Number.isInteger(spacing) || spacing < 1 || spacing > size) throw new Error('Invalid cluster settings');
  const ids = [], adjacency = [], byTile = new Map(), clusters = new Map();
  const columns = Math.ceil(grid.width / size);
  const portal = (x, y) => {
    const tile = y * grid.width + x;
    if (byTile.has(tile)) return byTile.get(tile);
    const id = ids.length;
    ids.push(tile); adjacency.push(new Map()); byTile.set(tile, id);
    const key = Math.floor(y / size) * columns + Math.floor(x / size);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(id);
    return id;
  };
  const connect = (a, b, cost) => { adjacency[a].set(b, cost); adjacency[b].set(a, cost); };
  const boundary = (length, pointA, pointB) => {
    let begin = -1;
    for (let i = 0; i <= length; i++) {
      const a = pointA(i), b = pointB(i);
      const open = i < length && grid.walkable(a.x, a.y) && grid.walkable(b.x, b.y);
      if (open && begin === -1) begin = i;
      if (!open && begin !== -1) {
        const samples = new Set([begin, i - 1]);
        for (let s = begin + spacing; s < i - 1; s += spacing) samples.add(s);
        for (const s of samples) {
          const p = pointA(s), q = pointB(s);
          connect(portal(p.x, p.y), portal(q.x, q.y), 1);
        }
        begin = -1;
      }
    }
  };
  for (let x = size; x < grid.width; x += size) for (let y = 0; y < grid.height; y += size) {
    boundary(Math.min(size, grid.height - y), i => ({ x: x - 1, y: y + i }), i => ({ x, y: y + i }));
  }
  for (let y = size; y < grid.height; y += size) for (let x = 0; x < grid.width; x += size) {
    boundary(Math.min(size, grid.width - x), i => ({ x: x + i, y: y - 1 }), i => ({ x: x + i, y }));
  }
  const point = id => ({ x: ids[id] % grid.width, y: Math.floor(ids[id] / grid.width) });
  for (const members of clusters.values()) for (let i = 0; i < members.length; i++) {
    const a = members[i], start = point(a), flood = clusterFlood(grid, clusterBounds(grid, size, start), start);
    for (let j = i + 1; j < members.length; j++) {
      const b = members[j], cost = flood.distance(point(b));
      if (cost > 0) connect(a, b, cost);
    }
  }
  const edgeCount = adjacency.reduce((sum, edges) => sum + edges.size, 0);
  const buffer = new ArrayBuffer(24 + ids.length * 4 + (ids.length + 1) * 4 + edgeCount * 6);
  const view = new DataView(buffer);
  [0x31485250, grid.width, grid.height, size, ids.length, edgeCount].forEach((n, i) => view.setUint32(i * 4, n, true));
  const offsetsStart = 24 + ids.length * 4, edgesStart = offsetsStart + (ids.length + 1) * 4;
  let edge = 0;
  for (let i = 0; i < ids.length; i++) {
    view.setUint32(24 + i * 4, ids[i], true); view.setUint32(offsetsStart + i * 4, edge, true);
    for (const [destination, cost] of adjacency[i]) {
      view.setUint32(edgesStart + edge * 6, destination, true); view.setUint16(edgesStart + edge * 6 + 4, cost, true); edge++;
    }
  }
  view.setUint32(offsetsStart + ids.length * 4, edge, true);
  return buffer;
}
