export function caveEndpoints(item) {
  if (!item?.entry || !item?.exit) return null;

  const { x: x1, y: y1 } = item.entry;
  const { x: x2, y: y2 } = item.exit;
  if (
    Number.isFinite(x1) &&
    Number.isFinite(y1) &&
    Number.isFinite(x2) &&
    Number.isFinite(y2)
  ) {
    return [x1, y1, x2, y2];
  }
  return null;
}

export function transportFocusZoom({
  currentZoom,
  minZoom,
  maxZoom,
  minZoomOffset = 2,
  extraZoom = 0
} = {}) {
  const current = Number.isFinite(currentZoom) ? currentZoom : 0;
  const offset = Number.isFinite(minZoomOffset) ? minZoomOffset : 0;
  const extra = Number.isFinite(extraZoom) ? extraZoom : 0;
  const baseZoom = Number.isFinite(minZoom) ? minZoom + offset : current;
  const desiredZoom = Math.max(current, baseZoom + extra);
  return Number.isFinite(maxZoom) ? Math.min(desiredZoom, maxZoom) : desiredZoom;
}
