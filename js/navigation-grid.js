export function decodeNavigationGrid(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 20 || view.getUint32(0, true) !== 0x314e5250) throw new Error('Invalid navigation data');
  const width = view.getUint32(4, true), height = view.getUint32(8, true), count = view.getUint32(12, true);
  const runsStart = 16 + (height + 1) * 4;
  if (!width || !height || width > 4096 || height > 4096 || runsStart + count * 8 !== view.byteLength) throw new Error('Invalid grid dimensions');
  const offsets = new Uint32Array(height + 1);
  for (let i = 0; i <= height; i++) offsets[i] = view.getUint32(16 + i * 4, true);
  if (offsets[0] !== 0 || offsets[height] !== count) throw new Error('Invalid row offsets');
  const mask = new Uint8Array(Math.ceil(width * height / 8));
  for (let y = 0; y < height; y++) {
    if (offsets[y] > offsets[y + 1] || offsets[y + 1] > count) throw new Error('Invalid row offsets');
    let previousEnd = 0;
    for (let r = offsets[y]; r < offsets[y + 1]; r++) {
      const p = runsStart + r * 8, left = view.getUint16(p, true), right = view.getUint16(p + 2, true);
      if (left < previousEnd || right <= left || right > width || !view.getUint32(p + 4, true)) throw new Error('Invalid walkable run');
      previousEnd = right;
      for (let id = y * width + left, end = y * width + right; id < end; id++) mask[id >> 3] |= 1 << (id & 7);
    }
  }
  const walkable = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const id = y * width + x;
    return !!(mask[id >> 3] & (1 << (id & 7)));
  };
  const component = (x, y) => {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) return 0;
    let low = offsets[y], high = offsets[y + 1] - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1, p = runsStart + mid * 8;
      if (x < view.getUint16(p, true)) high = mid - 1;
      else if (x >= view.getUint16(p + 2, true)) low = mid + 1;
      else return view.getUint32(p + 4, true);
    }
    return 0;
  };
  return { width, height, walkable, component };
}
