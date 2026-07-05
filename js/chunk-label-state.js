import {
  ZONE_BOSS_LEVEL,
  monsterLevelFilterActive,
  passesMonsterLevelFilter
} from './monster-utils.js';

export function chunkMonsterNames({
  encountersIndex,
  cx,
  cy,
  monsterLevelForName = () => null,
  min = null,
  max = null,
  exclusive = false,
  searchRegex = null
}) {
  const arr = encounterNamesForChunk(encountersIndex, cx, cy);
  if (!arr.length) return [];

  const sortedEntries = uniqueMonsterNames(arr)
    .map(name => ({ name, level: finiteMonsterLevel(name, monsterLevelForName) }))
    .sort(compareMonsterEntries);
  const filtered = sortedEntries.filter(entry => passesMonsterLevelFilter(entry.level, min, max));
  if (!filtered.length) return [];

  if (exclusive && monsterLevelFilterActive(min, max) && filtered.length !== sortedEntries.length) {
    return [];
  }

  const names = filtered.map(entry => entry.name);
  return searchRegex ? names.filter(name => regexTest(searchRegex, name)) : names;
}

export function isBossMonster(name, monsterLevelForName, bossLevel = ZONE_BOSS_LEVEL) {
  const lvl = finiteMonsterLevel(name, monsterLevelForName);
  return Number.isFinite(lvl) && lvl >= bossLevel;
}

export function selectTopMonster(names, monsterLevelForName = () => null) {
  if (!Array.isArray(names) || !names.length) return null;
  let bestName = null;
  let bestLevel = -Infinity;
  for (const name of names) {
    const lvl = finiteMonsterLevel(name, monsterLevelForName);
    if (Number.isFinite(lvl) && (bestName === null || lvl > bestLevel)) {
      bestName = name;
      bestLevel = lvl;
    }
  }
  if (bestName) return { name: bestName, level: bestLevel };
  const fallbackName = validMonsterName(names[0]);
  return fallbackName ? { name: fallbackName, level: finiteMonsterLevel(fallbackName, monsterLevelForName) } : null;
}

function encounterNamesForChunk(encountersIndex, cx, cy) {
  if (!encountersIndex || typeof encountersIndex.get !== 'function') return [];
  const arr = encountersIndex.get(`${cx},${cy}`);
  return Array.isArray(arr) ? arr : [];
}

function uniqueMonsterNames(names) {
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    const name = validMonsterName(raw);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function validMonsterName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

function finiteMonsterLevel(name, monsterLevelForName) {
  if (typeof monsterLevelForName !== 'function') return null;
  const lvl = monsterLevelForName(name);
  return Number.isFinite(lvl) ? lvl : null;
}

function compareMonsterEntries(a, b) {
  const la = Number.isFinite(a.level) ? a.level : -Infinity;
  const lb = Number.isFinite(b.level) ? b.level : -Infinity;
  if (lb !== la) return lb - la;
  return a.name.localeCompare(b.name);
}

function regexTest(regex, value) {
  if (typeof regex.test !== 'function') return false;
  regex.lastIndex = 0;
  return regex.test(value);
}
