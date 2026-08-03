export function monsterOverviewGroupSpan({
  chunkScreenPx,
  detailMinPx = 26,
  targetScreenPx = 112,
  maxSpan = 32
}) {
  if (Number.isFinite(chunkScreenPx) && chunkScreenPx >= detailMinPx) return 1;

  const safeChunkPx = Number.isFinite(chunkScreenPx) && chunkScreenPx > 0 ? chunkScreenPx : 0;
  const safeMaxSpan = Math.max(2, 2 ** Math.floor(Math.log2(Math.max(2, maxSpan))));
  let span = 2;
  while (span < safeMaxSpan && span * safeChunkPx < targetScreenPx) span *= 2;
  return Math.min(span, safeMaxSpan);
}

export function monsterOverviewLevelLabel(minLevel, maxLevel) {
  if (!Number.isFinite(minLevel) || !Number.isFinite(maxLevel)) return 'Lv ?';
  if (minLevel === maxLevel) return `Lv ${minLevel}`;
  return `Lv ${minLevel}-${maxLevel}`;
}

export function buildMonsterOverviewGroups({
  cx0,
  cx1,
  cy0,
  cy1,
  span,
  namesForChunk,
  monsterLevelForName
}) {
  if (
    !Number.isInteger(cx0) || !Number.isInteger(cx1) || cx0 > cx1 ||
    !Number.isInteger(cy0) || !Number.isInteger(cy1) || cy0 > cy1 ||
    !Number.isInteger(span) || span < 1 || typeof namesForChunk !== 'function'
  ) return [];

  const groups = new Map();
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const names = Array.from(new Set(
        (namesForChunk(cx, cy) || []).filter(name => typeof name === 'string' && name.length > 0)
      ));
      if (!names.length) continue;

      const groupCx = Math.floor(cx / span) * span;
      const groupCy = Math.floor(cy / span) * span;
      const key = `${span}:${groupCx},${groupCy}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          chunkX: groupCx,
          chunkY: groupCy,
          span,
          occupiedChunks: 0,
          centerChunkXTotal: 0,
          centerChunkYTotal: 0,
          minLevel: null,
          maxLevel: null,
          monsters: new Map()
        };
        groups.set(key, group);
      }

      group.occupiedChunks += 1;
      group.centerChunkXTotal += cx + 0.5;
      group.centerChunkYTotal += cy + 0.5;

      for (const name of names) {
        const rawLevel = typeof monsterLevelForName === 'function' ? monsterLevelForName(name) : null;
        const level = Number.isFinite(rawLevel) ? rawLevel : null;
        const current = group.monsters.get(name);
        if (current) {
          current.chunkCount += 1;
        } else {
          group.monsters.set(name, { name, level, chunkCount: 1 });
        }
        if (level !== null) {
          group.minLevel = group.minLevel === null ? level : Math.min(group.minLevel, level);
          group.maxLevel = group.maxLevel === null ? level : Math.max(group.maxLevel, level);
        }
      }
    }
  }

  return Array.from(groups.values())
    .map(group => {
      const topMonsters = Array.from(group.monsters.values()).sort((a, b) =>
        b.chunkCount - a.chunkCount ||
        (b.level ?? -Infinity) - (a.level ?? -Infinity) ||
        a.name.localeCompare(b.name)
      );
      return {
        key: group.key,
        chunkX: group.chunkX,
        chunkY: group.chunkY,
        span: group.span,
        occupiedChunks: group.occupiedChunks,
        centerChunkX: group.centerChunkXTotal / group.occupiedChunks,
        centerChunkY: group.centerChunkYTotal / group.occupiedChunks,
        minLevel: group.minLevel,
        maxLevel: group.maxLevel,
        levelLabel: monsterOverviewLevelLabel(group.minLevel, group.maxLevel),
        distinctMonsters: topMonsters.length,
        topMonsters
      };
    })
    .sort((a, b) => a.chunkY - b.chunkY || a.chunkX - b.chunkX);
}
