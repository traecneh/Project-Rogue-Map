// Keep a little less extra content on small screens. These are screen pixels,
// so the amount of preparation stays useful at every zoom level.
export function monsterViewportBuffer({ width, height }) {
  return Math.min(192, Math.max(64, Math.ceil(Math.min(width, height) / 3)));
}

export function monsterViewportNeedsRefresh(previous, next) {
  if (!previous) return true;
  if (['zoom', 'floor', 'width', 'height'].some(key => previous[key] !== next[key])) return true;
  const threshold = monsterViewportBuffer(next) / 2;
  return Math.abs(previous.x - next.x) >= threshold || Math.abs(previous.y - next.y) >= threshold;
}
