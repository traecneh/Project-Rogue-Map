// node tools/benchmark_smart_measure.mjs [--compare]
// Timings exclude asset I/O/decoding and vary by machine. --compare also runs
// the former flat A* strategy with its original 400,000-node / 4-second limits.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeNavigationGrid } from '../js/navigation-grid.js';
import { decodeNavigationHierarchy } from '../js/navigation-hierarchy.js';
import { findWalkingPath } from '../js/smart-pathfinding.js';
import { findSmartWalkingPath } from '../js/hierarchical-pathfinding.js';

const manifest = JSON.parse(readFileSync('data/navigation/manifest.json', 'utf8'));
const grids = {}, graphs = {};
const buffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
for (const [floor, info] of Object.entries(manifest.floors)) {
  grids[floor] = decodeNavigationGrid(buffer(readFileSync(`data/navigation/${info.file}`)));
  graphs[floor] = decodeNavigationHierarchy(buffer(gunzipSync(readFileSync(`data/navigation/${info.hierarchy.file}`))), grids[floor]);
}
const rows = [];
for (const entry of JSON.parse(readFileSync('tests/smart_measure_routes.json', 'utf8'))) {
  const grid = grids[entry.floor], strategies = [['Hybrid', () => findSmartWalkingPath(grid, async () => graphs[entry.floor], entry.start, entry.end)]];
  if (process.argv.includes('--compare')) strategies.unshift(['Flat A*', () => findWalkingPath(grid, entry.start, entry.end)]);
  for (const [strategy, run] of strategies) {
    const began = performance.now(), result = await run(), ms = Math.round(performance.now() - began);
    if (result.status === 'ok') {
      assert.deepEqual(result.path[0], entry.start); assert.deepEqual(result.path.at(-1), entry.end);
      let steps = 0;
      for (let i = 1; i < result.path.length; i++) {
        let { x, y } = result.path[i - 1]; const end = result.path[i], dx = Math.sign(end.x - x), dy = Math.sign(end.y - y);
        assert.ok(!dx || !dy || Math.abs(end.x - x) === Math.abs(end.y - y));
        while (x !== end.x || y !== end.y) {
          assert.ok(grid.walkable(x + dx, y + dy));
          if (dx && dy) assert.ok(grid.walkable(x + dx, y) && grid.walkable(x, y + dy));
          x += dx; y += dy; steps++;
        }
      }
      assert.equal(steps, result.steps);
      assert.ok(steps >= entry.optimalSteps);
    }
    rows.push({ route: entry.name, strategy, status: result.status, ms, steps: result.steps, optimal: entry.optimalSteps, extra: result.steps === undefined ? undefined : result.steps - entry.optimalSteps });
  }
}
console.table(rows);
