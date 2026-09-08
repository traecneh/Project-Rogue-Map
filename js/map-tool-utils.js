export function measureTileDistance(points) {
  let tiles = 0;
  for (let i = 1; i < points.length; i++) {
    tiles += Math.max(Math.abs(points[i].x - points[i - 1].x), Math.abs(points[i].y - points[i - 1].y));
  }
  return tiles;
}

export function formatTravelTime(seconds) {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  let remaining = Math.round(seconds);
  const hours = Math.floor(remaining / 3600);
  remaining %= 3600;
  const minutes = Math.floor(remaining / 60), secs = remaining % 60;
  return [hours && `${hours}h`, minutes && `${minutes}m`, secs && `${secs}s`].filter(Boolean).join(' ');
}

// Preserve the existing chunk-aligned preview. The encounter guide specifies a
// 10-chunk range, but does not establish the game's distance metric/edge shape.
export function elitePreviewBounds({ x, y, minX, maxX, height, chunkSize = 16 }) {
  const cx = Math.floor(x / chunkSize), cy = Math.floor(y / chunkSize);
  return {
    left: Math.max(minX, (cx - 10) * chunkSize),
    right: Math.min(maxX, (cx + 11) * chunkSize),
    top: Math.max(0, (cy - 10) * chunkSize),
    bottom: Math.min(height, (cy + 11) * chunkSize)
  };
}

export function nearestCrimSpawn(points, x, y) {
  let nearest = null, distance = Infinity;
  for (const point of points) {
    const candidate = Math.abs(x - point.x) + Math.abs(y - point.y);
    if (candidate < distance) {
      nearest = point;
      distance = candidate;
    }
  }
  return nearest;
}
