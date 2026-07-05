export const ZONE_BOSS_LEVEL = 105;

export const ZONE_DIFFICULTY_STEPS = [
  { limit: 20,  bg: '#4ade80', border: '#15803d', text: '#04210f' },
  { limit: 40,  bg: '#a3e635', border: '#3f6212', text: '#1f2f0c' },
  { limit: 60,  bg: '#facc15', border: '#b45309', text: '#301d04' },
  { limit: 80,  bg: '#f97316', border: '#c2410c', text: '#2b1003' },
  { limit: ZONE_BOSS_LEVEL - 1, bg: '#ef4444', border: '#991b1b', text: '#fff' },
  { limit: Infinity, bg: '#b91c1c', border: '#7f1d1d', text: '#fff', skull: true }
];

export function optionValueFromLevel(value) {
  return Number.isFinite(value) ? String(value) : '';
}

export function parseMonsterLevelValue(raw) {
  if (raw === '' || raw === undefined || raw === null) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

export function monsterLevelFilterActive(min, max) {
  return Number.isFinite(min) || Number.isFinite(max);
}

export function passesMonsterLevelFilter(level, min, max) {
  if (!monsterLevelFilterActive(min, max)) return true;
  if (!Number.isFinite(level)) return false;
  if (Number.isFinite(min) && level < min) return false;
  if (Number.isFinite(max) && level > max) return false;
  return true;
}

export function sortedMonsterLevelValues(monsterLevels) {
  return monsterLevels
    ? Array.from(new Set(Array.from(monsterLevels.values()).filter(Number.isFinite))).sort((a, b) => a - b)
    : [];
}

export function enforceMonsterLevelRangeValues(min, max, whichChanged) {
  const hasMin = Number.isFinite(min);
  const hasMax = Number.isFinite(max);
  if (!hasMin || !hasMax) return { min, max };
  if (min <= max) return { min, max };
  if (whichChanged === 'min') return { min, max: min };
  return { min: max, max };
}

export function formatZoneLevels(levels) {
  if (!levels) return '';
  const min = Number.isFinite(levels.min) ? levels.min : null;
  const max = Number.isFinite(levels.max) ? levels.max : null;
  if (min !== null && max !== null) return min === max ? `${min}` : `${min}-${max}`;
  if (min !== null) return `${min}+`;
  if (max !== null) return `≤${max}`;
  return '';
}

export function zoneMaxLevel(levels) {
  if (!levels) return null;
  const vals = [];
  if (Number.isFinite(levels.min)) vals.push(levels.min);
  if (Number.isFinite(levels.max)) vals.push(levels.max);
  return vals.length ? Math.max(...vals) : null;
}

export function zoneDifficultyStyle(level) {
  if (!Number.isFinite(level)) return ZONE_DIFFICULTY_STEPS[0];
  for (const step of ZONE_DIFFICULTY_STEPS) {
    if (level <= step.limit) return step;
  }
  return ZONE_DIFFICULTY_STEPS[ZONE_DIFFICULTY_STEPS.length - 1];
}

export function monsterDifficultyColor(level) {
  if (!Number.isFinite(level)) return null;
  const difficulty = zoneDifficultyStyle(level);
  if (!difficulty) return null;
  return difficulty.bg || difficulty.text || null;
}
