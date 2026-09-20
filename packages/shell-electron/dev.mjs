// Dev loop: start the Vite dev server for @umbra/app, then launch Electron pointed at it.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';

const server = await createServer({ configFile: '../app/vite.config.ts', root: '../app' });
await server.listen();
const info = server.httpServer.address();
const url = `http://localhost:${info.port}/`;
console.log('vite dev server:', url);

await new Promise((r) => setTimeout(r, 150));
const { spawnSync } = await import('node:child_process');
spawnSync(process.execPath, ['build.mjs'], { stdio: 'inherit' });

const child = spawn(electron, ['dist/main.js'], {
  stdio: 'inherit',
  env: { ...process.env, UMBRA_DEV_URL: url },
});
child.on('close', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
