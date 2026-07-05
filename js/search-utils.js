export function normalizeName(name) {
  return (name || '').trim().toLowerCase();
}

export function escapeSearchRegex(term) {
  return String(term || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createSearchRegex(term, exact) {
  const q = (term || '').trim();
  if (!q) return null;
  const escaped = escapeSearchRegex(q);
  return new RegExp(exact ? `^${escaped}$` : escaped, 'i');
}

export function findSearchEntryByName(searchItems, name) {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  return searchItems.find(item => item.normalized === normalized) || null;
}

export function findSearchSuggestions({
  term,
  searchItems,
  currentFloor,
  floorForX,
  searchTypeOrder,
  limit
}) {
  const clean = normalizeName(term);
  if (!clean) return [];
  const matches = [];
  for (const entry of searchItems) {
    const idx = entry.normalized.indexOf(clean);
    if (idx === -1) continue;
    matches.push({ entry, idx });
  }
  matches.sort((a, b) => {
    if (a.idx !== b.idx) return a.idx - b.idx;
    const ta = Number.isFinite(searchTypeOrder[a.entry.type]) ? searchTypeOrder[a.entry.type] : 99;
    const tb = Number.isFinite(searchTypeOrder[b.entry.type]) ? searchTypeOrder[b.entry.type] : 99;
    if (ta !== tb) return ta - tb;
    const fa = Number.isFinite(a.entry.x) ? (floorForX(a.entry.x) === currentFloor ? 0 : 1) : 0;
    const fb = Number.isFinite(b.entry.x) ? (floorForX(b.entry.x) === currentFloor ? 0 : 1) : 0;
    if (fa !== fb) return fa - fb;
    return a.entry.name.localeCompare(b.entry.name);
  });
  return matches.slice(0, limit).map(match => match.entry);
}
