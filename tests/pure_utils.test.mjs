import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampFloorX,
  floorBounds,
  floorConfig,
  floorForX,
  floorLabelForX,
  floorLocalX,
  floorViewportBounds,
  gameXYFromLatLng,
  globalFloorX,
  mapLat
} from '../js/coordinates.js';
import {
  ZONE_BOSS_LEVEL,
  enforceMonsterLevelRangeValues,
  formatZoneLevels,
  monsterDifficultyColor,
  monsterLevelFilterActive,
  optionValueFromLevel,
  parseMonsterLevelValue,
  passesMonsterLevelFilter,
  sortedMonsterLevelValues,
  zoneDifficultyStyle,
  zoneMaxLevel
} from '../js/monster-utils.js';
import {
  createSearchRegex,
  escapeSearchRegex,
  findSearchEntryByName,
  findSearchSuggestions,
  normalizeName
} from '../js/search-utils.js';

const FLOORS = {
  overworld: { key: 'overworld', label: 'Overworld', minX: 0, maxX: 4096, offset: 0 },
  underground: { key: 'underground', label: 'Underground', minX: 4096, maxX: 8192, offset: 4096 }
};

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

test('search helpers normalize, escape, and match names safely', () => {
  assert.equal(normalizeName('  Death Tyrant  '), 'death tyrant');
  assert.equal(normalizeName(null), '');
  assert.equal(escapeSearchRegex('a+b? [test]'), 'a\\+b\\? \\[test\\]');

  const exact = createSearchRegex('Death Tyrant', true);
  assert.ok(exact.test('Death Tyrant'));
  assert.equal(exact.test('Death Tyrant Lv 45'), false);

  const fuzzy = createSearchRegex('a+b?', false);
  assert.ok(fuzzy.test('spawn a+b? here'));
  assert.equal(fuzzy.test('spawn aaabz here'), false);
  assert.equal(createSearchRegex('   ', false), null);

  const entries = [
    { name: 'Farmtown', normalized: 'farmtown' },
    { name: 'Death Tyrant', normalized: 'death tyrant' }
  ];
  assert.deepEqual(findSearchEntryByName(entries, ' death tyrant '), entries[1]);
  assert.equal(findSearchEntryByName(entries, 'unknown'), null);
});

test('search suggestions preserve ranking by match, type, floor, and name', () => {
  const searchItems = [
    { name: 'Beta Mine', normalized: 'beta mine', type: 'poi', x: 120, y: 10 },
    { name: 'Alpha Town', normalized: 'alpha town', type: 'town', x: 4500, y: 20 },
    { name: 'Alpha Mine', normalized: 'alpha mine', type: 'poi', x: 120, y: 30 },
    { name: 'Alpha Shrine', normalized: 'alpha shrine', type: 'poi', x: 4500, y: 35 },
    { name: 'Alpha Monster', normalized: 'alpha monster', type: 'monster' },
    { name: 'Deep Alpha Shrine', normalized: 'deep alpha shrine', type: 'poi', x: 4500, y: 40 }
  ];

  const suggestions = findSearchSuggestions({
    term: 'alpha',
    searchItems,
    currentFloor: 'overworld',
    floorForX: x => floorForX(x, 4096),
    searchTypeOrder: { monster: 0, town: 1, poi: 2 },
    limit: 4
  });

  assert.deepEqual(
    suggestions.map(entry => entry.name),
    ['Alpha Monster', 'Alpha Town', 'Alpha Mine', 'Alpha Shrine']
  );
});

test('monster helpers parse, sort, filter, and enforce ranges', () => {
  assert.equal(optionValueFromLevel(45), '45');
  assert.equal(optionValueFromLevel(null), '');
  assert.equal(parseMonsterLevelValue('45'), 45);
  assert.equal(parseMonsterLevelValue(''), null);
  assert.equal(parseMonsterLevelValue('abc'), null);

  assert.equal(monsterLevelFilterActive(null, null), false);
  assert.equal(monsterLevelFilterActive(20, null), true);
  assert.equal(passesMonsterLevelFilter(30, 20, 40), true);
  assert.equal(passesMonsterLevelFilter(10, 20, 40), false);
  assert.equal(passesMonsterLevelFilter(null, 20, 40), false);

  const levels = new Map([
    ['a', 20],
    ['b', 5],
    ['c', 20],
    ['d', Number.NaN],
    ['e', Infinity]
  ]);
  assert.deepEqual(sortedMonsterLevelValues(levels), [5, 20]);

  assert.deepEqual(enforceMonsterLevelRangeValues(40, 20, 'min'), { min: 40, max: 40 });
  assert.deepEqual(enforceMonsterLevelRangeValues(40, 20, 'max'), { min: 20, max: 20 });
  assert.deepEqual(enforceMonsterLevelRangeValues(10, 20, 'min'), { min: 10, max: 20 });
});

test('zone helpers preserve current level formatting and difficulty thresholds', () => {
  assert.equal(ZONE_BOSS_LEVEL, 105);
  assert.equal(formatZoneLevels(null), '');
  assert.equal(formatZoneLevels({ min: 20, max: 20 }), '20');
  assert.equal(formatZoneLevels({ min: 20, max: 40 }), '20-40');
  assert.equal(formatZoneLevels({ min: 20 }), '20+');
  assert.equal(formatZoneLevels({ max: 40 }), '≤40');
  assert.equal(formatZoneLevels({ min: '20', max: '40' }), '');

  assert.equal(zoneMaxLevel(null), null);
  assert.equal(zoneMaxLevel({ min: 20, max: 40 }), 40);
  assert.equal(zoneMaxLevel({ min: 60 }), 60);
  assert.equal(zoneMaxLevel({ min: '20', max: '40' }), null);

  assert.equal(zoneDifficultyStyle(Number.NaN).bg, '#4ade80');
  assert.equal(zoneDifficultyStyle(20).bg, '#4ade80');
  assert.equal(zoneDifficultyStyle(21).bg, '#a3e635');
  assert.equal(zoneDifficultyStyle(104).bg, '#ef4444');
  assert.equal(zoneDifficultyStyle(105).skull, true);
  assert.equal(monsterDifficultyColor(45), '#facc15');
  assert.equal(monsterDifficultyColor(null), null);
});

test('coordinate helpers convert between image, game, and floor spaces', () => {
  assert.equal(mapLat(25, 100, true), 75);
  assert.equal(mapLat(25, 100, false), 25);
  assert.deepEqual(
    gameXYFromLatLng({ lng: 8199.6, lat: -2.2 }, { imageWidth: 8192, imageHeight: 4096, invertY: true, clamp }),
    [8192, 4096]
  );
  assert.deepEqual(
    gameXYFromLatLng({ lng: 12.4, lat: 99.6 }, { imageWidth: 8192, imageHeight: 4096, invertY: false, clamp }),
    [12, 100]
  );

  assert.equal(floorConfig(FLOORS, 'unknown'), FLOORS.overworld);
  assert.equal(floorForX(4095, 4096), 'overworld');
  assert.equal(floorForX(4096, 4096), 'underground');
  assert.equal(floorLabelForX(4096, 4096), 'UG');
  assert.equal(floorLocalX(4200, 'underground', FLOORS), 104);
  assert.equal(globalFloorX(104, 'underground', FLOORS), 4200);
  assert.equal(clampFloorX(9000, 'underground', FLOORS, clamp), 8191);

  const toFloorLL = (floor, x, y) => ({ floor, x, y });
  const latLngBounds = (a, b) => ({ a, b });
  assert.deepEqual(
    floorBounds('underground', FLOORS, 4096, toFloorLL, latLngBounds),
    { a: { floor: 'underground', x: 4096, y: 0 }, b: { floor: 'underground', x: 8192, y: 4096 } }
  );
  assert.deepEqual(
    floorViewportBounds('overworld', FLOORS, 4096, toFloorLL, latLngBounds, 10, 20),
    { a: { floor: 'overworld', x: -10, y: -20 }, b: { floor: 'overworld', x: 4106, y: 4116 } }
  );
});
