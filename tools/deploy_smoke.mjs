#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

export const DEFAULT_BASE_URL = 'https://traecneh.github.io/Project-Rogue-Map/';

export function normalizeBaseUrl(rawUrl = DEFAULT_BASE_URL) {
  const value = String(rawUrl || '').trim();
  if (!value) throw new Error('base URL is required');
  return value.endsWith('/') ? value : `${value}/`;
}

export function buildCheckResult(name, details) {
  return { name, ok: details.length === 0, details };
}

export function analyzeIndexHtml(html) {
  const scriptTags = Array.from(String(html || '').matchAll(/<script\b[^>]*>/gi), match => match[0]);
  const scripts = scriptTags.map(tag => ({
    src: readAttribute(tag, 'src') || '',
    type: (readAttribute(tag, 'type') || '').toLowerCase()
  }));
  return {
    scripts,
    appScripts: scripts.filter(script => isAppScriptSource(script.src))
  };
}

export function validateIndexHtml(html) {
  const { appScripts } = analyzeIndexHtml(html);
  const issues = [];
  if (!appScripts.some(script => script.type === 'module')) {
    issues.push('index.html must load ./js/app.js with type="module"');
  }
  if (appScripts.some(script => script.type !== 'module')) {
    issues.push('index.html still contains a non-module ./js/app.js script tag');
  }
  return issues;
}

export function validateConfigModule(source) {
  const text = String(source || '');
  const issues = [];
  if (!/\bexport\s+const\s+DATA\b/.test(text)) {
    issues.push('js/config.js did not contain the expected DATA export');
  }
  if (!/\bexport\s+const\s+FLOORS\b/.test(text)) {
    issues.push('js/config.js did not contain the expected FLOORS export');
  }
  return issues;
}

export function validateAppModule(source) {
  const text = String(source || '');
  const issues = [];
  if (!/from\s+['"]\.\/config\.js['"]/.test(text)) {
    issues.push('js/app.js did not import ./config.js');
  }
  if (!/from\s+['"]\.\/search-index\.js['"]/.test(text)) {
    issues.push('js/app.js did not import ./search-index.js');
  }
  if (!/from\s+['"]\.\/chunk-label-state\.js['"]/.test(text)) {
    issues.push('js/app.js did not import ./chunk-label-state.js');
  }
  if (!/from\s+['"]\.\/layer-state\.js['"]/.test(text)) {
    issues.push('js/app.js did not import ./layer-state.js');
  }
  if (!/from\s+['"]\.\/monster-filter-state\.js['"]/.test(text)) {
    issues.push('js/app.js did not import ./monster-filter-state.js');
  }
  if (!/from\s+['"]\.\/url-state\.js['"]/.test(text)) {
    issues.push('js/app.js did not import ./url-state.js');
  }
  if (/\bconst\s+IMG_PATH\s*=/.test(text)) {
    issues.push('js/app.js still contains the old inline IMG_PATH constant');
  }
  return issues;
}

export function validateLayerStateModule(source) {
  const text = String(source || '');
  const issues = [];
  if (!/\bexport\s+function\s+labelLayerKeyForSearchType\b/.test(text)) {
    issues.push('js/layer-state.js did not contain labelLayerKeyForSearchType');
  }
  if (!/\bexport\s+function\s+searchLabelMarkerState\b/.test(text)) {
    issues.push('js/layer-state.js did not contain searchLabelMarkerState');
  }
  return issues;
}

export function validateSearchIndexModule(source) {
  const text = String(source || '');
  const issues = [];
  if (!/\bexport\s+function\s+buildSearchIndex\b/.test(text)) {
    issues.push('js/search-index.js did not contain buildSearchIndex');
  }
  return issues;
}

export function validateChunkLabelStateModule(source) {
  const text = String(source || '');
  const issues = [];
  if (!/\bexport\s+function\s+chunkMonsterNames\b/.test(text)) {
    issues.push('js/chunk-label-state.js did not contain chunkMonsterNames');
  }
  if (!/\bexport\s+function\s+isBossMonster\b/.test(text)) {
    issues.push('js/chunk-label-state.js did not contain isBossMonster');
  }
  if (!/\bexport\s+function\s+selectTopMonster\b/.test(text)) {
    issues.push('js/chunk-label-state.js did not contain selectTopMonster');
  }
  return issues;
}

export function validateMonsterFilterStateModule(source) {
  const text = String(source || '');
  const issues = [];
  if (!/\bexport\s+function\s+monsterFilterStatusText\b/.test(text)) {
    issues.push('js/monster-filter-state.js did not contain monsterFilterStatusText');
  }
  if (!/\bexport\s+function\s+normalizeMonsterFilterExclusive\b/.test(text)) {
    issues.push('js/monster-filter-state.js did not contain normalizeMonsterFilterExclusive');
  }
  if (!/\bexport\s+function\s+reconcileMonsterFilterState\b/.test(text)) {
    issues.push('js/monster-filter-state.js did not contain reconcileMonsterFilterState');
  }
  return issues;
}

export function validateUrlStateModule(source) {
  const text = String(source || '');
  const issues = [];
  if (!/\bexport\s+function\s+searchTermFromUrlSearch\b/.test(text)) {
    issues.push('js/url-state.js did not contain searchTermFromUrlSearch');
  }
  if (!/\bexport\s+function\s+urlWithSearchTerm\b/.test(text)) {
    issues.push('js/url-state.js did not contain urlWithSearchTerm');
  }
  if (!/\bexport\s+function\s+coordinateTargetFromUrlSearch\b/.test(text)) {
    issues.push('js/url-state.js did not contain coordinateTargetFromUrlSearch');
  }
  if (!/\bexport\s+function\s+normalizeCoordinateTarget\b/.test(text)) {
    issues.push('js/url-state.js did not contain normalizeCoordinateTarget');
  }
  return issues;
}

export async function runDeploySmoke({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available in this Node runtime');
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const checks = [];

  const index = await fetchText(fetchImpl, normalizedBaseUrl);
  checks.push(buildCheckResult('index.html', responseIssues(index)));
  checks.push(buildCheckResult('module app script', index.ok ? validateIndexHtml(index.text) : ['index.html could not be inspected']));

  const config = await fetchText(fetchImpl, new URL('js/config.js', normalizedBaseUrl).href);
  checks.push(buildCheckResult('js/config.js', [
    ...responseIssues(config),
    ...(config.ok ? validateConfigModule(config.text) : [])
  ]));

  const app = await fetchText(fetchImpl, new URL('js/app.js', normalizedBaseUrl).href);
  checks.push(buildCheckResult('js/app.js', [
    ...responseIssues(app),
    ...(app.ok ? validateAppModule(app.text) : [])
  ]));

  const searchIndex = await fetchText(fetchImpl, new URL('js/search-index.js', normalizedBaseUrl).href);
  checks.push(buildCheckResult('js/search-index.js', [
    ...responseIssues(searchIndex),
    ...(searchIndex.ok ? validateSearchIndexModule(searchIndex.text) : [])
  ]));

  const chunkLabelState = await fetchText(fetchImpl, new URL('js/chunk-label-state.js', normalizedBaseUrl).href);
  checks.push(buildCheckResult('js/chunk-label-state.js', [
    ...responseIssues(chunkLabelState),
    ...(chunkLabelState.ok ? validateChunkLabelStateModule(chunkLabelState.text) : [])
  ]));

  const layerState = await fetchText(fetchImpl, new URL('js/layer-state.js', normalizedBaseUrl).href);
  checks.push(buildCheckResult('js/layer-state.js', [
    ...responseIssues(layerState),
    ...(layerState.ok ? validateLayerStateModule(layerState.text) : [])
  ]));

  const monsterFilterState = await fetchText(fetchImpl, new URL('js/monster-filter-state.js', normalizedBaseUrl).href);
  checks.push(buildCheckResult('js/monster-filter-state.js', [
    ...responseIssues(monsterFilterState),
    ...(monsterFilterState.ok ? validateMonsterFilterStateModule(monsterFilterState.text) : [])
  ]));

  const urlState = await fetchText(fetchImpl, new URL('js/url-state.js', normalizedBaseUrl).href);
  checks.push(buildCheckResult('js/url-state.js', [
    ...responseIssues(urlState),
    ...(urlState.ok ? validateUrlStateModule(urlState.text) : [])
  ]));

  const mapImage = await fetchResource(fetchImpl, new URL('img/Map_Combined.png', normalizedBaseUrl).href);
  checks.push(buildCheckResult('map image', responseIssues(mapImage)));

  return {
    baseUrl: normalizedBaseUrl,
    ok: checks.every(check => check.ok),
    checks
  };
}

function isAppScriptSource(src) {
  return src === './js/app.js' || src === 'js/app.js';
}

function readAttribute(tag, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = pattern.exec(tag);
  return match ? (match[2] || match[3] || match[4] || '') : '';
}

async function fetchText(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } });
  const text = typeof response.text === 'function' ? await response.text() : '';
  return { ok: !!response.ok, status: response.status || 0, text, url };
}

async function fetchResource(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } });
  return { ok: !!response.ok, status: response.status || 0, url };
}

function responseIssues(result) {
  return result.ok ? [] : [`GET ${result.url} returned HTTP ${result.status}`];
}

function formatResult(result) {
  const lines = [`Deployment smoke check: ${result.baseUrl}`];
  for (const check of result.checks) {
    lines.push(`[${check.ok ? 'PASS' : 'FAIL'}] ${check.name}`);
    for (const detail of check.details) {
      lines.push(`  - ${detail}`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const baseUrl = process.argv[2] || DEFAULT_BASE_URL;
  const result = await runDeploySmoke({ baseUrl });
  console.log(formatResult(result));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
