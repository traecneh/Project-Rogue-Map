// Layouts depend on the ordered names, cell dimensions, and the current
// font/level data. Call clear() when either of the latter changes.
export function createChunkLabelLayoutCache(limit = 512) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Invalid layout cache limit');
  const entries = new Map();
  let revision = 0;
  const keyFor = (width, height, names) => JSON.stringify([width, height, names]);
  return {
    get revision() { return revision; },
    get size() { return entries.size; },
    get(width, height, names) {
      const key = keyFor(width, height, names);
      const value = entries.get(key);
      if (value) {
        entries.delete(key);
        entries.set(key, value);
      }
      return value;
    },
    set(width, height, names, layout) {
      const key = keyFor(width, height, names);
      entries.delete(key);
      entries.set(key, Object.freeze({ ...layout }));
      if (entries.size > limit) entries.delete(entries.keys().next().value);
    },
    clear() {
      entries.clear();
      revision += 1;
    }
  };
}
