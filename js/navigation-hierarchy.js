export function decodeNavigationHierarchy(buffer, grid) {
  const view = new DataView(buffer);
  if (view.byteLength < 28 || view.getUint32(0, true) !== 0x31485250) throw new Error('Invalid hierarchy');
  const width = view.getUint32(4, true), height = view.getUint32(8, true), size = view.getUint32(12, true);
  const count = view.getUint32(16, true), edgeCount = view.getUint32(20, true);
  const offsetsStart = 24 + count * 4, edgesStart = offsetsStart + (count + 1) * 4;
  if (width !== grid.width || height !== grid.height || size < 2 || size > 64 || edgesStart + edgeCount * 6 !== buffer.byteLength) throw new Error('Invalid hierarchy dimensions');
  const tiles = new Uint32Array(count), offsets = new Uint32Array(count + 1);
  const destinations = new Uint32Array(edgeCount), costs = new Uint16Array(edgeCount);
  const columns = Math.ceil(width / size), clusters = new Map(), seen = new Set();
  const cluster = point => Math.floor(point.y / size) * columns + Math.floor(point.x / size);
  const point = id => ({ x: tiles[id] % width, y: Math.floor(tiles[id] / width) });
  for (let i = 0; i <= count; i++) offsets[i] = view.getUint32(offsetsStart + i * 4, true);
  if (offsets[0] !== 0 || offsets[count] !== edgeCount) throw new Error('Invalid hierarchy offsets');
  for (let i = 0; i < count; i++) {
    tiles[i] = view.getUint32(24 + i * 4, true);
    const p = point(i), key = cluster(p);
    if (seen.has(tiles[i]) || !grid.component(p.x, p.y) || offsets[i] > offsets[i + 1] || offsets[i + 1] > edgeCount) throw new Error('Invalid portal');
    seen.add(tiles[i]);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(i);
  }
  for (let i = 0; i < edgeCount; i++) {
    destinations[i] = view.getUint32(edgesStart + i * 6, true); costs[i] = view.getUint16(edgesStart + i * 6 + 4, true);
    if (destinations[i] >= count || !costs[i]) throw new Error('Invalid hierarchy edge');
  }
  return { size, count, offsets, destinations, costs, point, cluster, members: point => clusters.get(cluster(point)) || [] };
}
