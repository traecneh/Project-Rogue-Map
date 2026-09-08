import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { decodeNavigationGrid } from '../js/navigation-grid.js';
import { findWalkingPath } from '../js/smart-pathfinding.js';
import { decodeNavigationHierarchy } from '../js/navigation-hierarchy.js';
import { findHierarchicalPath, findSmartWalkingPath } from '../js/hierarchical-pathfinding.js';
import { buildHierarchy } from '../tools/navigation-hierarchy.mjs';

function fixture(rows) {
  const width = rows[0].length, height = rows.length;
  const walkable = (x, y) => x >= 0 && y >= 0 && x < width && y < height && rows[y][x] !== '#';
  const labels = new Map();
  let label = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!walkable(x, y) || labels.has(y * width + x)) continue;
    const queue = [{ x, y }]; labels.set(y * width + x, ++label);
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i];
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const nx = p.x + dx, ny = p.y + dy, id = ny * width + nx;
        if (walkable(nx, ny) && !labels.has(id)) { labels.set(id, label); queue.push({ x: nx, y: ny }); }
      }
    }
  }
  return { width, height, walkable, component: (x, y) => walkable(x, y) ? labels.get(y * width + x) : 0 };
}

function shortestSteps(grid, start, end) {
  const queue = [{ ...start, steps: 0 }], seen = new Set([start.y * grid.width + start.x]);
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    if (p.x === end.x && p.y === end.y) return p.steps;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = p.x + dx, y = p.y + dy, id = y * grid.width + x;
      if ((!dx && !dy) || seen.has(id) || !grid.walkable(x, y)) continue;
      if (dx && dy && (!grid.walkable(p.x + dx, p.y) || !grid.walkable(p.x, p.y + dy))) continue;
      seen.add(id); queue.push({ x, y, steps: p.steps + 1 });
    }
  }
  return null;
}

function verifyPath(grid, result, start, end) {
  assert.deepEqual(result.path[0], start);
  assert.deepEqual(result.path.at(-1), end);
  let steps = 0;
  for (let i = 1; i < result.path.length; i++) {
    let { x, y } = result.path[i - 1];
    const target = result.path[i];
    const dx = Math.sign(target.x - x), dy = Math.sign(target.y - y);
    assert.ok(!dx || !dy || Math.abs(target.x - x) === Math.abs(target.y - y));
    while (x !== target.x || y !== target.y) {
      assert.ok(grid.walkable(x + dx, y + dy), 'Path crosses a blocked tile');
      if (dx && dy) assert.ok(grid.walkable(x + dx, y) && grid.walkable(x, y + dy), 'Path cuts a blocked corner');
      x += dx; y += dy; steps++;
    }
  }
  assert.equal(result.steps, steps);
}

test('A* agrees with independent breadth-first routes across deterministic obstacle grids', async () => {
  let seed = 7654321;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let scenario = 0; scenario < 60; scenario++) {
    const rows = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => random() < .23 ? '#' : '.'));
    rows[0][0] = '.'; rows[15][15] = '.';
    const grid = fixture(rows), start = { x: 0, y: 0 }, end = { x: 15, y: 15 };
    const expected = shortestSteps(grid, start, end);
    const result = await findWalkingPath(grid, start, end, { maxNodes: 300, maxMs: 1000 });
    if (expected === null) assert.equal(result.status, 'unreachable');
    else { assert.equal(result.status, 'ok'); assert.equal(result.steps, expected); verifyPath(grid, result, start, end); }
  }
});

test('blocked points, diagonal squeezing, cancellation and search limits have distinct outcomes', async () => {
  const blocked = fixture(['.#', '#.']);
  assert.equal((await findWalkingPath(blocked, { x: 0, y: 0 }, { x: 1, y: 0 })).status, 'blocked');
  assert.equal((await findWalkingPath(blocked, { x: 0, y: 0 }, { x: 1, y: 1 })).status, 'unreachable');
  const detour = fixture(['..#..', '..#..', '.....']);
  assert.equal((await findWalkingPath(detour, { x: 0, y: 0 }, { x: 4, y: 0 }, { maxNodes: 1 })).status, 'limit');
  assert.equal((await findWalkingPath(detour, { x: 0, y: 0 }, { x: 4, y: 0 }, { cancelled: () => true })).status, 'cancelled');
});

test('shipped navigation grids match their checksums and the four confirmed samples', () => {
  const manifest = JSON.parse(readFileSync('data/navigation/manifest.json', 'utf8'));
  assert.deepEqual(manifest.blockedTileIds, [0, 1, 53, 60]);
  for (const [floor, info] of Object.entries(manifest.floors)) {
    const bytes = readFileSync(`data/navigation/${info.file}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), info.sha256);
    const grid = decodeNavigationGrid(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.equal(grid.width, 4096); assert.equal(grid.height, 4096);
    const samples = floor === 'overworld' ? [[2041, 638], [1545, 783], [1928, 618]] : [[6099 - 4096, 1762]];
    for (const [x, y] of samples) { assert.equal(grid.walkable(x, y), false); assert.equal(grid.component(x, y), 0); }
    assert.equal(grid.component(-1, 0), 0); assert.equal(grid.component(4096, 0), 0);
  }
  assert.throws(() => decodeNavigationGrid(new ArrayBuffer(20)));
});

test('hierarchy preserves narrow openings, partial clusters and local disconnected regions', async () => {
  let seed = 623714;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let scenario = 0; scenario < 60; scenario++) {
    const rows = Array.from({ length: 17 }, () => Array.from({ length: 19 }, () => random() < .25 ? '#' : '.'));
    rows[0][0] = '.'; rows[16][18] = '.';
    const grid = fixture(rows), start = { x: 0, y: 0 }, end = { x: 18, y: 16 };
    const hierarchy = decodeNavigationHierarchy(buildHierarchy(grid, 4, 2), grid);
    const expected = shortestSteps(grid, start, end);
    const result = await findHierarchicalPath(grid, hierarchy, start, end);
    if (expected === null) assert.equal(result.status, 'unreachable');
    else { assert.equal(result.status, 'ok'); assert.ok(result.steps >= expected); verifyPath(grid, result, start, end); }
  }
  // Both endpoints are in one cluster, separated locally but connected by
  // leaving it. Endpoint insertion must allow that detour.
  const grid = fixture(['.#......', '.#......', '.#......', '.#......', '........']);
  const start = { x: 0, y: 0 }, end = { x: 2, y: 0 };
  const graph = decodeNavigationHierarchy(buildHierarchy(grid, 4, 2), grid);
  const result = await findHierarchicalPath(grid, graph, start, end);
  assert.equal(result.status, 'ok'); verifyPath(grid, result, start, end);
  assert.equal(result.steps, shortestSteps(grid, start, end));
});

test('hierarchical budgets, asynchronous cancellation and short-route lazy loading', async () => {
  const grid = fixture(Array.from({ length: 128 }, (_, y) => Array.from({ length: 128 }, (_, x) => x === 64 && y < 127 ? '#' : '.')));
  const start = { x: 0, y: 0 }, end = { x: 127, y: 0 };
  const hierarchy = decodeNavigationHierarchy(buildHierarchy(grid, 16, 4), grid);
  assert.equal((await findHierarchicalPath(grid, hierarchy, start, end, { maxMs: 0 })).status, 'limit');
  assert.equal((await findHierarchicalPath(grid, hierarchy, start, end, { cancelled: () => true })).status, 'cancelled');
  let cancelled = false;
  const timer = setTimeout(() => { cancelled = true; }, 0);
  const result = await findHierarchicalPath(grid, hierarchy, start, end, { cancelled: () => cancelled, yieldEvery: 1, yieldMs: 0 });
  clearTimeout(timer);
  assert.equal(result.status, 'cancelled');
  let loads = 0;
  const loader = async () => { loads++; return hierarchy; };
  assert.equal((await findSmartWalkingPath(grid, loader, { x: 0, y: 0 }, { x: 30, y: 0 })).status, 'ok');
  assert.equal(loads, 0);
  const disconnected = fixture(['.#', '#.']);
  assert.equal((await findSmartWalkingPath(disconnected, loader, { x: 0, y: 0 }, { x: 1, y: 1 })).status, 'unreachable');
  assert.equal(loads, 0);
  assert.throws(() => decodeNavigationHierarchy(new ArrayBuffer(28), grid));
  const damaged = buildHierarchy(grid, 16, 4);
  new DataView(damaged).setUint32(4, 999, true);
  assert.throws(() => decodeNavigationHierarchy(damaged, grid));
});

test('real routes remain close to independently established shortest paths on both floors', async () => {
  const manifest = JSON.parse(readFileSync('data/navigation/manifest.json', 'utf8'));
  const grids = {}, graphs = {};
  const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  for (const [floor, info] of Object.entries(manifest.floors)) {
    const grid = grids[floor] = decodeNavigationGrid(arrayBuffer(readFileSync(`data/navigation/${info.file}`)));
    const bytes = readFileSync(`data/navigation/${info.hierarchy.file}`);
    assert.equal(info.hierarchy.gridSha256, info.sha256);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), info.hierarchy.sha256);
    const decoded = gunzipSync(bytes);
    assert.equal(decoded.length, info.hierarchy.decodedBytes);
    graphs[floor] = decodeNavigationHierarchy(arrayBuffer(decoded), grid);
  }
  const routes = JSON.parse(readFileSync('tests/smart_measure_routes.json', 'utf8'));
  for (const entry of routes) {
    const grid = grids[entry.floor];
    const result = await findSmartWalkingPath(grid, async () => graphs[entry.floor], entry.start, entry.end);
    assert.equal(result.status, 'ok', entry.name);
    verifyPath(grid, result, entry.start, entry.end);
    assert.ok(result.steps >= entry.optimalSteps && result.steps <= Math.ceil(entry.optimalSteps * 1.01), `${entry.name}: ${result.steps} vs ${entry.optimalSteps}`);
  }
  const grid = grids.underground, regions = new Map();
  for (let y = 0; y < grid.height; y += 17) for (let x = 0; x < grid.width; x += 17) {
    const id = grid.component(x, y);
    if (!id) continue;
    if (!regions.has(id)) regions.set(id, []);
    regions.get(id).push({ x, y });
  }
  const samples = [...regions.values()].filter(points => points.length > 20).sort((a, b) => b.length - a.length).slice(0, 10);
  assert.equal(samples.length, 10);
  for (const points of samples) {
    const start = points[0], end = points.at(-1);
    const expected = await findWalkingPath(grid, start, end, { maxNodes: 600000, maxMs: 15000, yieldEvery: 20000 });
    assert.equal(expected.status, 'ok');
    const result = await findSmartWalkingPath(grid, async () => graphs.underground, start, end);
    assert.equal(result.status, 'ok'); verifyPath(grid, result, start, end);
    assert.ok(result.steps >= expected.steps && result.steps <= Math.ceil(expected.steps * 1.02), `Underground: ${result.steps} vs ${expected.steps}`);
  }
  let checks = 0;
  const interrupted = await findHierarchicalPath(grids.overworld, graphs.overworld, { x: 800, y: 600 }, { x: 2222, y: 3078 }, { cancelled: () => ++checks > 4 });
  assert.equal(interrupted.status, 'cancelled');
});
