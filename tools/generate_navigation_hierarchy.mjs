import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { decodeNavigationGrid } from '../js/navigation-grid.js';
import { buildHierarchy } from './navigation-hierarchy.mjs';

const directory = process.argv[2];
if (!directory) throw new Error('Expected navigation output directory');
const manifestPath = join(directory, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
for (const [floor, info] of Object.entries(manifest.floors)) {
  const bytes = readFileSync(join(directory, info.file));
  const grid = decodeNavigationGrid(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const started = performance.now(), buffer = buildHierarchy(grid);
  const file = `${floor}-hierarchy.bin`;
  const compressed = gzipSync(new Uint8Array(buffer), { level: 9 });
  writeFileSync(join(directory, file), compressed);
  info.hierarchy = { file, encoding: 'gzip', decodedBytes: buffer.byteLength, sha256: createHash('sha256').update(compressed).digest('hex'), gridSha256: info.sha256 };
  console.log(`${floor} hierarchy: ${compressed.byteLength.toLocaleString()} download bytes, ${((performance.now() - started) / 1000).toFixed(1)}s`);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
