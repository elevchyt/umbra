import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

/**
 * The dev server must send the same cross-origin isolation headers the app:// protocol does,
 * otherwise SharedArrayBuffer (the pointer ring buffer) is unavailable in dev only.
 */
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [
    // HMR is disabled deliberately. The workspace owns a Worker and a canvas whose control
    // has been transferred with transferControlToOffscreen(); neither can be recreated on the
    // same element, so a hot remount silently orphans the live engine and leaves a second,
    // empty one driving the canvas. A full reload on edit is the correct trade here.
    solid({ hot: false }),
  ],
  base: './',
  server: { headers: isolation, port: 5273, strictPort: true },
  preview: { headers: isolation },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // Keep chunk names stable so the budget script can attribute sizes.
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
  esbuild: { legalComments: 'none' },
});
