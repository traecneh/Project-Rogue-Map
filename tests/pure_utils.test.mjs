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
  chunkMonsterNames,
  isBossMonster,
  selectTopMonster
} from '../js/chunk-label-state.js';
import {
  createSearchRegex,
  escapeSearchRegex,
  findSearchEntryByName,
  findSearchSuggestions,
  normalizeName
} from '../js/search-utils.js';
import { buildSearchIndex } from '../js/search-index.js';
import {
  bestSearchClusterCenter,
  searchEntryFocusTarget,
  searchLabelZoom,
  searchMatchCount,
  searchTypeForRun
} from '../js/search-focus-state.js';
import {
  labelLayerKeyForSearchType,
  searchLabelMarkerState
} from '../js/layer-state.js';
import {
  monsterFilterStatusText,
  normalizeMonsterFilterExclusive,
  reconcileMonsterFilterState
} from '../js/monster-filter-state.js';
import {
  coordinateTargetFromUrlSearch,
  parseCoordinateValue,
  readQueryParam,
  searchTermFromUrlSearch,
  urlWithSearchTerm,
  normalizeCoordinateTarget as normalizeUrlCoordinateTarget
} from '../js/url-state.js';
import {
  normalizeCaveList,
  normalizeCrimList,
  normalizeEncounterIndex,
  normalizeMonsterLevels,
  normalizePoiList,
  normalizePortalList,
  normalizeTownList,
  normalizeZoneList
} from '../js/data-normalization.js';
import {
  isPortalLabelItem,
  portalEndpoints,
  splitPortalItems
} from '../js/portal-state.js';

const FLOORS = {
  overworld: { key: 'overworld', label: 'Overworld', minX: 0, maxX: 4096, offset: 0 },
  underground: { key: 'underground', label: 'Underground', minX: 4096, maxX: 8192, offset: 4096 }
};

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

test('data normalization helpers preserve known array payloads and wrappers', () => {
  const towns = [{ name: 'Farmtown', x: 80, y: 120 }, { name: '', x: Number.NaN }];
  const pois = [{ name: 'Ancient Ruins', x: 4500, y: 310 }];
  const portals = [{ x1: 1, y1: 2, x2: 3, y2: 4 }];
  const caves = [{ entry: { x: 1, y: 2 }, exit: { x: 3, y: 4 } }];
  const zones = [{ levels: { min: 1, max: 2 } }];
  const crim = [{ name: 'Crim', x: 5, y: 6 }];

  assert.equal(normalizeTownList(towns), towns);
  assert.equal(normalizePoiList(pois), pois);
  assert.equal(normalizePortalList(portals), portals);
  assert.equal(normalizeCrimList(crim), crim);
  assert.deepEqual(normalizeTownList(null), []);
  assert.deepEqual(normalizePoiList({ items: pois }), []);
  assert.deepEqual(normalizeCaveList({ items: caves }), caves);
  assert.deepEqual(normalizeCaveList(caves), caves);
  assert.deepEqual(normalizeCaveList({ items: null }), []);
  assert.deepEqual(normalizeZoneList({ zones }), zones);
  assert.deepEqual(normalizeZoneList(zones), zones);
  assert.deepEqual(normalizeZoneList({ zones: null }), []);
});

test('data normalization helpers build encounter and monster level maps', () => {
  const encounters = normalizeEncounterIndex({
    '1,2': ['Death Tyrant', 'Wisp'],
    '3,4': 'not-an-array'
  });
  assert.ok(encounters instanceof Map);
  assert.deepEqual(Array.from(encounters.entries()), [
    ['1,2', ['Death Tyrant', 'Wisp']],
    ['3,4', 'not-an-array']
  ]);
  assert.equal(normalizeEncounterIndex(null), null);
  assert.equal(normalizeEncounterIndex(['bad']), null);

  const levels = normalizeMonsterLevels({
    ' Death Tyrant ': '105',
    Wisp: 30,
    Goblin: 'bad',
    '': 1,
    Infinite: Infinity
  });
  assert.ok(levels instanceof Map);
  assert.deepEqual(Array.from(levels.entries()), [
    ['death tyrant', 105],
    ['wisp', 30]
  ]);
  assert.equal(normalizeMonsterLevels(null), null);
  assert.equal(normalizeMonsterLevels(['bad']), null);
});

test('portal helpers detect supported endpoint shapes', () => {
  assert.deepEqual(portalEndpoints({ entry: { x: 1, y: 2 }, exit: { x: 3, y: 4 } }), [1, 2, 3, 4]);
  assert.deepEqual(portalEndpoints({ from: { x: 5, y: 6 }, to: { x: 7, y: 8 } }), [5, 6, 7, 8]);
  assert.deepEqual(portalEndpoints({ a: { x: 9, y: 10 }, b: { x: 11, y: 12 } }), [9, 10, 11, 12]);
  assert.deepEqual(portalEndpoints({ x1: 13, y1: 14, x2: 15, y2: 16 }), [13, 14, 15, 16]);
  assert.equal(portalEndpoints({ x1: 13, y1: 14, x2: 15, y2: Number.NaN }), null);
  assert.equal(portalEndpoints(null), null);
});

test('portal helpers split endpoint pairs from label-only records', () => {
  const pair = { x1: 1, y1: 2, x2: 3, y2: 4 };
  const label = { name: 'Portal Label', x: 20, y: 30 };
  const invalidLabel = { name: 'Bad Label', x: 20, y: Infinity };
  const bothShapes = { name: 'Endpoint Wins', x: 50, y: 60, from: { x: 5, y: 6 }, to: { x: 7, y: 8 } };
  const split = splitPortalItems([label, pair, invalidLabel, bothShapes, null]);

  assert.equal(isPortalLabelItem(label), true);
  assert.equal(isPortalLabelItem(invalidLabel), false);
  assert.deepEqual(split.portalPairs, [pair, bothShapes]);
  assert.deepEqual(split.portalLabels, [label]);
  assert.deepEqual(splitPortalItems(null), { portalPairs: [], portalLabels: [] });
});

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

test('search focus helpers resolve exact search types and entry focus targets', () => {
  const monster = { name: 'Death Tyrant', type: 'monster' };
  const town = { name: 'Farmtown', type: 'town', x: 80, y: 120 };
  const poi = { name: 'Ancient Ruins', type: 'poi', x: 4500, y: 310 };

  assert.equal(searchTypeForRun({ term: '', exact: true, currentSearchType: 'monster', entry: monster }), null);
  assert.equal(searchTypeForRun({ term: 'death', exact: false, currentSearchType: null, entry: monster }), null);
  assert.equal(searchTypeForRun({ term: 'Death Tyrant', exact: true, currentSearchType: null, entry: monster }), 'monster');
  assert.equal(searchTypeForRun({ term: 'Farmtown', exact: true, currentSearchType: 'poi', entry: town }), 'poi');

  assert.deepEqual(searchEntryFocusTarget({ entry: null, currentZoom: 2, minZoom: 0, maxZoom: 6 }), { kind: 'matches' });
  assert.deepEqual(searchEntryFocusTarget({ entry: monster, currentZoom: 2, minZoom: 0, maxZoom: 6 }), { kind: 'matches' });
  assert.deepEqual(searchEntryFocusTarget({ entry: { ...poi, x: Number.NaN }, currentZoom: 2, minZoom: 0, maxZoom: 6 }), { kind: 'matches' });
  assert.deepEqual(searchEntryFocusTarget({ entry: town, currentZoom: 2, minZoom: 0, maxZoom: 6 }), {
    kind: 'point',
    x: 80,
    y: 120,
    zoom: 2,
    duration: 0.8
  });
  assert.deepEqual(searchEntryFocusTarget({ entry: poi, currentZoom: 5, minZoom: 0, maxZoom: 6 }), {
    kind: 'point',
    x: 4500,
    y: 310,
    zoom: 5,
    duration: 0.8
  });
});

test('search focus helpers find clustered monster matches and label zoom', () => {
  const encountersIndex = new Map([
    ['1,1', ['Death Tyrant', 'Wisp']],
    ['2,1', ['Death Tyrant', 'Death Tyrant']],
    ['10,10', ['Death Tyrant']],
    ['bad,key', ['Death Tyrant']],
    ['3,1', ['Goblin']]
  ]);
  const regex = createSearchRegex('Death Tyrant', true);

  assert.equal(searchMatchCount(['Death Tyrant', 'Goblin', null, 'Death Tyrant'], regex), 2);
  assert.deepEqual(
    bestSearchClusterCenter({ encountersIndex, searchRegex: regex, radius: 1 }),
    { cx: 5 / 3, cy: 1 }
  );
  assert.equal(bestSearchClusterCenter({ encountersIndex, searchRegex: null, radius: 1 }), null);

  assert.equal(
    searchLabelZoom({
      minZoom: 0,
      maxZoom: 4,
      currentZoom: 2,
      neededPx: 20,
      chunkScreenSizeAtZoom: z => [8 * 2 ** z, 10 * 2 ** z]
    }),
    2
  );
  assert.equal(
    searchLabelZoom({
      minZoom: Number.NaN,
      maxZoom: Number.NaN,
      currentZoom: 3,
      neededPx: 200,
      chunkScreenSizeAtZoom: () => [10, 10]
    }),
    3
  );
});

test('search index helper builds sorted monster, town, and poi entries', () => {
  const encountersIndex = new Map([
    ['1,1', ['Death Tyrant', 'Goblin', 'death tyrant', '', null]],
    ['2,1', ['Wisp', 'Goblin']]
  ]);
  const towns = [
    { name: 'Farmtown', x: 80, y: 120 },
    { name: 'Broken Town', x: Number.NaN, y: 30 },
    { name: '', x: 10, y: 30 }
  ];
  const pois = [
    { name: 'Ancient Ruins', x: 4500, y: 310 },
    { name: 'Bad POI', x: 10, y: Infinity }
  ];
  const levels = new Map([
    ['death tyrant', 45],
    ['goblin', 5],
    ['wisp', 30]
  ]);

  const items = buildSearchIndex({
    encountersIndex,
    towns,
    pois,
    monsterLevelForName: name => levels.get(normalizeName(name)) ?? null
  });

  assert.deepEqual(
    items.map(item => [item.name, item.type, item.normalized, item.level ?? null, item.x ?? null, item.y ?? null]),
    [
      ['Ancient Ruins', 'poi', 'ancient ruins', null, 4500, 310],
      ['Death Tyrant', 'monster', 'death tyrant', 45, null, null],
      ['Farmtown', 'town', 'farmtown', null, 80, 120],
      ['Goblin', 'monster', 'goblin', 5, null, null],
      ['Wisp', 'monster', 'wisp', 30, null, null]
    ]
  );
});

test('url helpers read and persist search query state without dropping unrelated params', () => {
  assert.equal(searchTermFromUrlSearch('?q=Fallback&search=Death%20Tyrant'), 'Death Tyrant');
  assert.equal(searchTermFromUrlSearch('?q=Fallback'), 'Fallback');
  assert.equal(searchTermFromUrlSearch('?search=%20%20'), '');
  assert.equal(readQueryParam(new URLSearchParams('x=&y=12'), ['x', 'y']), '12');

  assert.equal(
    urlWithSearchTerm({
      pathname: '/Project-Rogue-Map/',
      search: '?foo=1&q=Old&search=Old',
      hash: '#map'
    }, ' Death Tyrant '),
    '/Project-Rogue-Map/?foo=1&search=Death+Tyrant#map'
  );
  assert.equal(
    urlWithSearchTerm({
      pathname: '/Project-Rogue-Map/',
      search: '?foo=1&q=Old&search=Old',
      hash: '#map'
    }, ''),
    '/Project-Rogue-Map/?foo=1#map'
  );
});

test('url helpers parse and normalize coordinate deep links', () => {
  assert.equal(parseCoordinateValue('12.6'), 13);
  assert.equal(parseCoordinateValue('abc'), null);
  assert.equal(parseCoordinateValue(''), null);
  assert.deepEqual(coordinateTargetFromUrlSearch('?x=4096.2&y=25.7'), { x: 4096, y: 26 });
  assert.equal(coordinateTargetFromUrlSearch('?x=10'), null);

  assert.deepEqual(
    normalizeUrlCoordinateTarget({
      target: { x: 9000, y: -5 },
      imageWidth: 8192,
      imageHeight: 4096,
      clamp,
      floorForX: x => floorForX(x, 4096),
      clampFloorX: (x, floor) => clampFloorX(x, floor, FLOORS, clamp)
    }),
    { x: 8191, y: 0 }
  );
  assert.equal(
    normalizeUrlCoordinateTarget({
      target: null,
      imageWidth: 8192,
      imageHeight: 4096,
      clamp,
      floorForX: x => floorForX(x, 4096),
      clampFloorX: (x, floor) => clampFloorX(x, floor, FLOORS, clamp)
    }),
    null
  );
});

test('search layer helpers keep monster searches from hiding enabled labels', () => {
  assert.equal(labelLayerKeyForSearchType('town'), 'towns');
  assert.equal(labelLayerKeyForSearchType('poi'), 'pois');
  assert.equal(labelLayerKeyForSearchType('monster'), null);
  assert.equal(labelLayerKeyForSearchType(null), null);

  const townSearch = createSearchRegex('Farmtown', true);
  assert.deepEqual(
    searchLabelMarkerState({
      labelText: 'Farmtown',
      searchRegex: townSearch,
      activeSearchType: 'town'
    }),
    { matches: true, hidden: false }
  );
  assert.deepEqual(
    searchLabelMarkerState({
      labelText: 'Ancient Ruins',
      searchRegex: townSearch,
      activeSearchType: 'town'
    }),
    { matches: false, hidden: true }
  );

  assert.deepEqual(
    searchLabelMarkerState({
      labelText: 'Farmtown',
      searchRegex: createSearchRegex('Death Tyrant', true),
      activeSearchType: 'monster'
    }),
    { matches: false, hidden: false }
  );
  assert.deepEqual(
    searchLabelMarkerState({
      labelText: 'Farmtown',
      searchRegex: null,
      activeSearchType: null
    }),
    { matches: false, hidden: false }
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

test('monster filter state helpers normalize exclusive mode and stale level values', () => {
  assert.equal(normalizeMonsterFilterExclusive(true, [10, 20]), true);
  assert.equal(normalizeMonsterFilterExclusive(true, []), false);
  assert.equal(normalizeMonsterFilterExclusive(false, [10, 20]), false);

  assert.deepEqual(
    reconcileMonsterFilterState({
      levelValues: [10, 20, 30],
      min: 20,
      max: 40,
      exclusive: true
    }),
    { min: 20, max: null, exclusive: true }
  );
  assert.deepEqual(
    reconcileMonsterFilterState({
      levelValues: [],
      min: 20,
      max: 30,
      exclusive: true
    }),
    { min: null, max: null, exclusive: false }
  );
});

test('monster filter status text covers unavailable, default, ranges, and exclusive mode', () => {
  const hints = {
    default: 'Showing all levels. Set min/max to filter.',
    unavailable: 'Monster level data unavailable.',
    needRange: 'Set min/max to use Exclusive mode.'
  };

  assert.equal(monsterFilterStatusText({ levelValues: [], min: null, max: null, exclusive: false, hints }), hints.unavailable);
  assert.equal(monsterFilterStatusText({ levelValues: [10], min: null, max: null, exclusive: false, hints }), hints.default);
  assert.equal(monsterFilterStatusText({ levelValues: [10], min: null, max: null, exclusive: true, hints }), hints.needRange);
  assert.equal(monsterFilterStatusText({ levelValues: [10, 20], min: 10, max: 20, exclusive: false, hints }), 'Filtering levels 10 to 20');
  assert.equal(monsterFilterStatusText({ levelValues: [10, 20], min: 10, max: 10, exclusive: false, hints }), 'Filtering level 10');
  assert.equal(monsterFilterStatusText({ levelValues: [10, 20], min: 10, max: null, exclusive: false, hints }), 'Filtering levels 10+');
  assert.equal(monsterFilterStatusText({ levelValues: [10, 20], min: null, max: 20, exclusive: true, hints }), 'Filtering levels up to 20 · Exclusive');
});

test('chunk label helper de-duplicates, sorts, and filters monster names', () => {
  const encountersIndex = new Map([
    ['1,2', ['Wisp', 'Death Tyrant', 'Goblin', 'Dragon', 'Wisp', 'Unknown', '', null]]
  ]);
  const levels = new Map([
    ['death tyrant', 105],
    ['dragon', 50],
    ['wisp', 30],
    ['goblin', 5]
  ]);
  const monsterLevelForName = name => levels.get(normalizeName(name)) ?? null;

  assert.deepEqual(
    chunkMonsterNames({
      encountersIndex,
      cx: 1,
      cy: 2,
      monsterLevelForName
    }),
    ['Death Tyrant', 'Dragon', 'Wisp', 'Goblin', 'Unknown']
  );
  assert.deepEqual(
    chunkMonsterNames({
      encountersIndex,
      cx: 1,
      cy: 2,
      monsterLevelForName,
      min: 20,
      max: 60
    }),
    ['Dragon', 'Wisp']
  );
  assert.deepEqual(
    chunkMonsterNames({
      encountersIndex,
      cx: 1,
      cy: 2,
      monsterLevelForName,
      searchRegex: createSearchRegex('wisp', true)
    }),
    ['Wisp']
  );
});

test('chunk label helper hides mixed-level chunks in exclusive mode', () => {
  const encountersIndex = new Map([
    ['1,2', ['Dragon', 'Wisp']],
    ['2,2', ['Dragon', 'Wisp', 'Goblin']]
  ]);
  const levels = new Map([
    ['dragon', 50],
    ['wisp', 30],
    ['goblin', 5]
  ]);
  const monsterLevelForName = name => levels.get(normalizeName(name)) ?? null;

  assert.deepEqual(
    chunkMonsterNames({
      encountersIndex,
      cx: 1,
      cy: 2,
      monsterLevelForName,
      min: 20,
      max: 60,
      exclusive: true
    }),
    ['Dragon', 'Wisp']
  );
  assert.deepEqual(
    chunkMonsterNames({
      encountersIndex,
      cx: 2,
      cy: 2,
      monsterLevelForName,
      min: 20,
      max: 60,
      exclusive: true
    }),
    []
  );
});

test('chunk label helper selects top monsters and identifies bosses', () => {
  const levels = new Map([
    ['death tyrant', 105],
    ['dragon', 50],
    ['wisp', 30]
  ]);
  const monsterLevelForName = name => levels.get(normalizeName(name)) ?? null;

  assert.deepEqual(
    selectTopMonster(['Wisp', 'Dragon', 'Death Tyrant'], monsterLevelForName),
    { name: 'Death Tyrant', level: 105 }
  );
  assert.deepEqual(
    selectTopMonster(['Unknown'], monsterLevelForName),
    { name: 'Unknown', level: null }
  );
  assert.equal(isBossMonster('Death Tyrant', monsterLevelForName), true);
  assert.equal(isBossMonster('Dragon', monsterLevelForName), false);
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
