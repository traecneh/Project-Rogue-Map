export const SEARCH_PARAM_KEYS = ['search', 'q'];
export const COORDINATE_X_PARAM_KEYS = ['x'];
export const COORDINATE_Y_PARAM_KEYS = ['y'];

export function readQueryParam(paramsOrSearch, keys) {
  const params = normalizeParams(paramsOrSearch);
  for (const key of keys || []) {
    const val = params.get(key);
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return '';
}

export function searchTermFromUrlSearch(search, keys = SEARCH_PARAM_KEYS) {
  return readQueryParam(search, keys);
}

export function urlWithSearchTerm(location, term, keys = SEARCH_PARAM_KEYS) {
  const params = normalizeParams(location?.search || '');
  keys.forEach(key => params.delete(key));
  const clean = (term || '').trim();
  if (clean) params.set(keys[0], clean);
  const qs = params.toString();
  return `${location?.pathname || ''}${qs ? '?' + qs : ''}${location?.hash || ''}`;
}

export function parseCoordinateValue(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const num = Number(raw.trim());
  return Number.isFinite(num) ? Math.round(num) : null;
}

export function coordinateTargetFromUrlSearch(
  search,
  xKeys = COORDINATE_X_PARAM_KEYS,
  yKeys = COORDINATE_Y_PARAM_KEYS
) {
  const params = normalizeParams(search);
  const x = parseCoordinateValue(readQueryParam(params, xKeys));
  const y = parseCoordinateValue(readQueryParam(params, yKeys));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

export function normalizeCoordinateTarget({
  target,
  imageWidth,
  imageHeight,
  clamp,
  floorForX,
  clampFloorX
}) {
  if (!target || !imageWidth || !imageHeight) return null;
  const rawX = clamp(Math.round(target.x), 0, imageWidth);
  const floor = floorForX(rawX);
  const x = clampFloorX(rawX, floor);
  const y = clamp(Math.round(target.y), 0, imageHeight);
  return { x, y };
}

function normalizeParams(paramsOrSearch) {
  if (paramsOrSearch && typeof paramsOrSearch.get === 'function') return paramsOrSearch;
  return new URLSearchParams(paramsOrSearch || '');
}
