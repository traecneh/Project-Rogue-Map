import { normalizeName } from './search-utils.js';

export function buildSearchIndex({
  encountersIndex,
  locales,
  pois,
  monsterLevelForName = () => null
}) {
  const items = [];

  const add = payload => {
    if (!payload || typeof payload.name !== 'string') return;
    const normalized = normalizeName(payload.name);
    if (!normalized) return;
    const normalizedAliases = Array.isArray(payload.aliases)
      ? payload.aliases.map(normalizeName).filter(Boolean)
      : [];
    items.push({ ...payload, normalized, normalizedAliases });
  };

  const monsterSeen = new Set();
  const encounterValues = encountersIndex && typeof encountersIndex.values === 'function'
    ? encountersIndex.values()
    : [];
  for (const arr of encounterValues) {
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      if (typeof raw !== 'string') continue;
      const normalized = normalizeName(raw);
      if (!normalized || monsterSeen.has(normalized)) continue;
      monsterSeen.add(normalized);
      add({ name: raw, type: 'monster', level: monsterLevelForName(raw) });
    }
  }

  const localeNames = new Set();
  for (const item of locales || []) {
    const { name, x, y } = item || {};
    if (typeof name !== 'string' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    add({ ...item, type: 'locale' });
    localeNames.add(normalizeName(name));
    for (const alias of item.aliases || []) localeNames.add(normalizeName(alias));
  }

  addLabeledPoints(items, pois, 'poi', localeNames);

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

function addLabeledPoints(items, records, type, excludedNames = new Set()) {
  for (const item of records || []) {
    const { name, x, y } = item || {};
    if (typeof name !== 'string' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const normalized = normalizeName(name);
    if (!normalized || excludedNames.has(normalized)) continue;
    items.push({ name, x, y, type, normalized, normalizedAliases: [] });
  }
}
