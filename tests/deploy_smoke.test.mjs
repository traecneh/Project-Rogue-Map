import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeIndexHtml,
  buildCheckResult,
  normalizeBaseUrl,
  runDeploySmoke,
  validateConfigModule,
  validateIndexHtml
} from '../tools/deploy_smoke.mjs';

test('normalizes deployment base URLs with a trailing slash', () => {
  assert.equal(normalizeBaseUrl('https://example.test/map'), 'https://example.test/map/');
  assert.equal(normalizeBaseUrl('https://example.test/map/'), 'https://example.test/map/');
});

test('detects module app script and rejects the old classic app script', () => {
  const moduleHtml = '<script src="https://unpkg.com/leaflet.js"></script><script type="module" src="./js/app.js"></script>';
  const classicHtml = '<script src="https://unpkg.com/leaflet.js"></script><script src="./js/app.js"></script>';

  assert.deepEqual(analyzeIndexHtml(moduleHtml).appScripts, [
    { src: './js/app.js', type: 'module' }
  ]);
  assert.deepEqual(validateIndexHtml(moduleHtml), []);
  assert.deepEqual(validateIndexHtml(classicHtml), [
    'index.html must load ./js/app.js with type="module"',
    'index.html still contains a non-module ./js/app.js script tag'
  ]);
});

test('validates the config module content', () => {
  assert.deepEqual(validateConfigModule('export const DATA = {}; export const FLOORS = {};'), []);
  assert.deepEqual(validateConfigModule('export const DATA = {};'), [
    'js/config.js did not contain the expected FLOORS export'
  ]);
});

test('runDeploySmoke checks index, config, app, and map image assets', async () => {
  const responses = new Map([
    ['https://example.test/map/', response(200, '<script type="module" src="./js/app.js"></script>')],
    ['https://example.test/map/js/config.js', response(200, 'export const DATA = {}; export const FLOORS = {};')],
    ['https://example.test/map/js/app.js', response(200, "import { DATA } from './config.js'; import { buildSearchIndex } from './search-index.js'; import { chunkMonsterNames } from './chunk-label-state.js'; import { searchTypeForRun } from './search-focus-state.js'; import { normalizeTownList } from './data-normalization.js'; import { searchLabelMarkerState } from './layer-state.js'; import { monsterFilterStatusText } from './monster-filter-state.js'; import { urlWithSearchTerm } from './url-state.js';")],
    ['https://example.test/map/js/data-normalization.js', response(200, 'export function normalizeTownList() {} export function normalizeEncounterIndex() {} export function normalizeMonsterLevels() {} export function normalizePoiList() {}')],
    ['https://example.test/map/js/search-index.js', response(200, 'export function buildSearchIndex() {}')],
    ['https://example.test/map/js/chunk-label-state.js', response(200, 'export function chunkMonsterNames() {} export function isBossMonster() {} export function selectTopMonster() {}')],
    ['https://example.test/map/js/search-focus-state.js', response(200, 'export function searchTypeForRun() {} export function searchEntryFocusTarget() {} export function bestSearchClusterCenter() {} export function searchLabelZoom() {}')],
    ['https://example.test/map/js/layer-state.js', response(200, 'export function labelLayerKeyForSearchType() {} export function searchLabelMarkerState() {}')],
    ['https://example.test/map/js/monster-filter-state.js', response(200, 'export function monsterFilterStatusText() {} export function normalizeMonsterFilterExclusive() {} export function reconcileMonsterFilterState() {}')],
    ['https://example.test/map/js/url-state.js', response(200, 'export function searchTermFromUrlSearch() {} export function urlWithSearchTerm() {} export function coordinateTargetFromUrlSearch() {} export function normalizeCoordinateTarget() {}')],
    ['https://example.test/map/img/Map_Combined.png', response(200, '')]
  ]);

  const result = await runDeploySmoke({
    baseUrl: 'https://example.test/map',
    fetchImpl: async url => responses.get(String(url)) || response(404, 'missing')
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map(check => check.name), [
    'index.html',
    'module app script',
    'js/config.js',
    'js/app.js',
    'js/data-normalization.js',
    'js/search-index.js',
    'js/chunk-label-state.js',
    'js/search-focus-state.js',
    'js/layer-state.js',
    'js/monster-filter-state.js',
    'js/url-state.js',
    'map image'
  ]);
});

test('runDeploySmoke reports stale deployments', async () => {
  const responses = new Map([
    ['https://example.test/map/', response(200, '<script src="./js/app.js"></script>')],
    ['https://example.test/map/js/config.js', response(404, 'not found')],
    ['https://example.test/map/js/app.js', response(200, "const IMG_PATH = './img/Map_Combined.png';")],
    ['https://example.test/map/js/data-normalization.js', response(404, 'not found')],
    ['https://example.test/map/js/search-index.js', response(404, 'not found')],
    ['https://example.test/map/js/chunk-label-state.js', response(404, 'not found')],
    ['https://example.test/map/js/search-focus-state.js', response(404, 'not found')],
    ['https://example.test/map/js/layer-state.js', response(404, 'not found')],
    ['https://example.test/map/js/monster-filter-state.js', response(404, 'not found')],
    ['https://example.test/map/js/url-state.js', response(404, 'not found')],
    ['https://example.test/map/img/Map_Combined.png', response(200, '')]
  ]);

  const result = await runDeploySmoke({
    baseUrl: 'https://example.test/map/',
    fetchImpl: async url => responses.get(String(url)) || response(404, 'missing')
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.checks.filter(check => !check.ok).map(check => check.name),
    ['module app script', 'js/config.js', 'js/app.js', 'js/data-normalization.js', 'js/search-index.js', 'js/chunk-label-state.js', 'js/search-focus-state.js', 'js/layer-state.js', 'js/monster-filter-state.js', 'js/url-state.js']
  );
});

test('buildCheckResult preserves pass/fail detail', () => {
  assert.deepEqual(buildCheckResult('thing', []), { name: 'thing', ok: true, details: [] });
  assert.deepEqual(buildCheckResult('thing', ['broken']), { name: 'thing', ok: false, details: ['broken'] });
});

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body;
    }
  };
}
