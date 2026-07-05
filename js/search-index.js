import { normalizeName } from './search-utils.js';

export function buildSearchIndex({
  encountersIndex,
  towns,
  pois,
  monsterLevelForName = () => null
}) {
  const items = [];

  const add = payload => {
    if (!payload || typeof payload.name !== 'string') return;
    const normalized = normalizeName(payload.name);
    if (!normalized) return;
    items.push({ ...payload, normalized });
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

  addLabeledPoints(items, towns, 'town');
  addLabeledPoints(items, pois, 'poi');

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

function addLabeledPoints(items, records, type) {
  for (const item of records || []) {
    const { name, x, y } = item || {};
    if (typeof name !== 'string' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const normalized = normalizeName(name);
    if (!normalized) continue;
    items.push({ name, x, y, type, normalized });
  }
}
