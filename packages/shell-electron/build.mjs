// Bundles the Electron main process and preload with esbuild (already present via Vite).
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });

const common = { bundle: true, platform: 'node', target: 'node22', external: ['electron'], minify: process.env.NODE_ENV === 'production', sourcemap: true };

// electron-updater is bundled in (a packaged build ships no node_modules). It is CommonJS and
// require()s Node built-ins, which an ES-module bundle can only do through createRequire.
const cjsInterop = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);";
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.js', format: 'esm', banner: { js: cjsInterop } });
// The preload must be CommonJS: sandboxed preloads are not ES modules.
await build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', format: 'cjs' });

console.log('shell-electron: built dist/main.js + dist/preload.cjs');
