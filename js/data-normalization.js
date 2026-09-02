import { normalizeName } from './search-utils.js';

export function normalizePoiList(raw) {
  return normalizeArray(raw);
}

export function normalizePortalList(raw) {
  return normalizeArray(raw);
}

export function normalizeCrimList(raw) {
  return normalizeArray(raw);
}

export function normalizeCaveList(raw) {
  if (Array.isArray(raw)) return raw;
  return Array.isArray(raw?.items) ? raw.items : [];
}

export function normalizeZoneList(raw) {
  if (Array.isArray(raw?.zones)) return raw.zones;
  return Array.isArray(raw) ? raw : [];
}

export function normalizeWarfrontData(raw) {
  return {
    warfronts: Array.isArray(raw?.warfronts) ? raw.warfronts : [],
    labels: Array.isArray(raw?.labels) ? raw.labels : []
  };
}

export function normalizeLocaleData(raw) {
  return {
    locales: Array.isArray(raw?.locales) ? raw.locales : [],
    labels: Array.isArray(raw?.labels) ? raw.labels : []
  };
}

export function normalizeEncounterIndex(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return new Map(Object.entries(raw));
}

export function normalizeMonsterLevels(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const levels = new Map();
  for (const [name, level] of Object.entries(raw)) {
    const normalized = normalizeName(name);
    if (!normalized) continue;
    const num = Number(level);
    if (!Number.isFinite(num)) continue;
    levels.set(normalized, num);
  }
  return levels;
}

function normalizeArray(raw) {
  return Array.isArray(raw) ? raw : [];
}
