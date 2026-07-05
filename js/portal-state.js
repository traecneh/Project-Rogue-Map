export function portalEndpoints(item) {
  if (item?.entry && item?.exit) {
    return [item.entry.x, item.entry.y, item.exit.x, item.exit.y];
  }
  if (item?.from && item?.to) {
    return [item.from.x, item.from.y, item.to.x, item.to.y];
  }
  if (item?.a && item?.b) {
    return [item.a.x, item.a.y, item.b.x, item.b.y];
  }
  if (
    item &&
    Number.isFinite(item.x1) &&
    Number.isFinite(item.y1) &&
    Number.isFinite(item.x2) &&
    Number.isFinite(item.y2)
  ) {
    return [item.x1, item.y1, item.x2, item.y2];
  }
  return null;
}

export function isPortalLabelItem(item) {
  return !!item && Number.isFinite(item.x) && Number.isFinite(item.y) && typeof item.name === 'string';
}

export function splitPortalItems(items) {
  const portalPairs = [];
  const portalLabels = [];
  if (!Array.isArray(items)) return { portalPairs, portalLabels };

  for (const item of items) {
    if (portalEndpoints(item)) {
      portalPairs.push(item);
    } else if (isPortalLabelItem(item)) {
      portalLabels.push(item);
    }
  }

  return { portalPairs, portalLabels };
}
