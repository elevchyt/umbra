import { app, BrowserWindow, protocol, net, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** Renderer bundle produced by `@umbra/app`. */
const APP_ROOT = join(here, '..', '..', 'app', 'dist');

const DEV_URL = process.env.UMBRA_DEV_URL ?? '';
const SPIKES = process.argv.includes('--spikes');

/**
 * Cross-origin isolation is required for SharedArrayBuffer, which carries the pointer-input
 * ring buffer between the UI thread and the engine worker (spec 03 §2).
 */
const ISOLATION_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const CSP = [
  "default-src 'self' app:",
  "script-src 'self' app: 'wasm-unsafe-eval'",
  "style-src 'self' app: 'unsafe-inline'",
  "img-src 'self' app: data: blob:",
  "font-src 'self' app: data:",
  "connect-src 'self' app: data: blob:",
  "worker-src 'self' app: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function serveApp(): void {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    // Single-page app: unknown paths fall back to the shell document.
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';

    // Contain the resolved path inside APP_ROOT.
    const resolved = normalize(join(APP_ROOT, rel));
    if (resolved !== APP_ROOT && !resolved.startsWith(APP_ROOT + sep)) {
      return new Response('forbidden', { status: 403 });
    }

    const res = await net.fetch(pathToFileURL(resolved).toString()).catch(() => null);
    const body = res && res.ok ? res.body : null;
    if (!body) {
      return new Response('not found', { status: 404, headers: { ...ISOLATION_HEADERS } });
    }
    const ext = resolved.slice(resolved.lastIndexOf('.'));
    return new Response(body, {
      headers: {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Security-Policy': CSP,
        ...ISOLATION_HEADERS,
      },
    });
  });
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: '#282828',
    // Frameless so the in-app menu bar owns the titlebar area (spec 01 §1).
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webgl: true,
      backgroundThrottling: false,
      // Chromium's own spellcheck/autofill are pointless here and cost memory.
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    if (!SPIKES) win.show();
  });

  // Never navigate away from our own origin, and open real links in the user's browser.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // No renderer may request camera, mic, geolocation and so on.
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  const hash = SPIKES ? '#spikes' : '';
  if (DEV_URL) await win.loadURL(DEV_URL + hash);
  else await win.loadURL('app://umbra/index.html' + hash);

  return win;
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

void app.whenReady().then(async () => {
  serveApp();

  ipcMain.handle('umbra:versions', () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  }));

  if (SPIKES) {
    const win = await createWindow();
    const timeoutMs = 180_000;
    const done = new Promise<{ pass: boolean; text: string }>((resolve) => {
      ipcMain.once('umbra:spikes-done', (_e, payload) => resolve(payload));
      setTimeout(() => resolve({ pass: false, text: 'TIMEOUT waiting for spike results' }), timeoutMs);
    });
    // Surface renderer console output so spike failures are diagnosable from CI logs.
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning')
        console.error(`[renderer] ${e.message}  (${e.sourceId}:${e.lineNumber})`);
    });
    const result = await done;
    process.stdout.write(result.text + '\n');
    process.exitCode = result.pass ? 0 : 1;
    app.quit();
    return;
  }

  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});
