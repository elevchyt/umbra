#!/usr/bin/env node
/**
 * Enforces the payload budgets from docs/spec/03-architecture.md §9.
 *
 * "Lightweight is a feature" only stays true if it is measured on every build, so this runs
 * in CI and fails the build when a budget is exceeded.
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'packages/app/dist');

/** name → { limitKb, match } over gzipped bytes. */
/**
 * Fixtures served for manual testing are not part of the shipped payload, so they must not
 * count against it.
 */
const IGNORED = (f) => /\.(psd|psb)$/i.test(f);

const BUDGETS = [
  { name: 'core UI (js+css, gzip)', limitKb: 1536, match: (f) => /^assets\/index-.*\.(js|css)$/.test(f) },
  { name: 'engine worker (js, gzip)', limitKb: 1536, match: (f) => /^assets\/worker-.*\.js$/.test(f) },
  { name: 'total payload (gzip)', limitKb: 3072, match: () => true },
];

function walk(dir, base = '') {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push({ rel, abs });
  }
  return out;
}

let files;

try {
  files = walk(DIST);
} catch {
  console.error(`No build found at ${DIST}. Run: pnpm --filter @umbra/app build`);
  process.exit(2);
}

const sized = files.filter(({ rel }) => !IGNORED(rel)).map(({ rel, abs }) => {
  const raw = readFileSync(abs);
  // Compressible assets are served gzipped; images and wasm are counted as-is.
  const compressible = ['.js', '.css', '.html', '.json', '.svg', '.wasm'].includes(extname(rel));
  return { rel, raw: raw.length, gz: compressible ? gzipSync(raw, { level: 9 }).length : raw.length };
});

console.log('\nBuild payload:');
for (const f of [...sized].sort((a, b) => b.gz - a.gz)) {
  console.log(`  ${(f.gz / 1024).toFixed(1).padStart(8)} KB gz  ${(f.raw / 1024).toFixed(1).padStart(8)} KB raw  ${f.rel}`);
}

let failed = false;
console.log('\nBudgets:');
for (const b of BUDGETS) {
  const total = sized.filter((f) => b.match(f.rel)).reduce((n, f) => n + f.gz, 0);
  const kb = total / 1024;
  const ok = kb <= b.limitKb;
  if (!ok) failed = true;
  const pct = ((kb / b.limitKb) * 100).toFixed(0);
  console.log(
    `  ${ok ? 'OK  ' : 'OVER'}  ${b.name.padEnd(28)} ${kb.toFixed(1).padStart(8)} KB / ${b.limitKb} KB  (${pct}%)`,
  );
}

console.log('');
process.exit(failed ? 1 : 0);
