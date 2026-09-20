// Regenerates the package `exports` map from the source tree.
// Needed because a wildcard "./*" cannot cover both .ts and .tsx: bundlers do not honour the
// exports fallback-array form, so each subpath is listed explicitly.
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('src', import.meta.url).pathname;
const walk = (dir) =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const exportsMap = { '.': './src/index.ts' };
for (const abs of walk(SRC)) {
  const rel = relative(SRC, abs).replace(/\\/g, '/');
  if (rel === 'index.ts') continue;
  if (rel.endsWith('.ts') || rel.endsWith('.tsx')) {
    exportsMap[`./${rel.replace(/\.tsx?$/, '')}`] = `./src/${rel}`;
  } else if (rel.endsWith('.css')) {
    exportsMap[`./${rel}`] = `./src/${rel}`;
  }
}

const pkgPath = new URL('package.json', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.exports = exportsMap;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`ui: ${Object.keys(exportsMap).length} export entries`);
