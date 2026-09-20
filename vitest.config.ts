import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src`, import.meta.url));

export default defineConfig({
  // Some shell modules (panel registry, tool metadata) live alongside JSX, so tests that
  // import them need the Solid transform even though they assert on plain data.
  plugins: [solid()],
  resolve: {
    alias: [
      // Match the workspace `exports` map so tests import the same specifiers as the app.
      // No extension in the replacement: Vite then resolves .ts or .tsx itself, which the
      // UI package needs since its components are .tsx and its data modules are .ts.
      { find: /^@umbra\/core\/(.*)$/, replacement: `${pkg('core')}/$1` },
      { find: '@umbra/core', replacement: `${pkg('core')}/index.ts` },
      { find: /^@umbra\/engine\/(.*)$/, replacement: `${pkg('engine')}/$1` },
      { find: '@umbra/engine', replacement: `${pkg('engine')}/index.ts` },
      { find: /^@umbra\/psd\/(.*)$/, replacement: `${pkg('psd')}/$1` },
      { find: '@umbra/psd', replacement: `${pkg('psd')}/index.ts` },
      { find: /^@umbra\/ui\/(.*)$/, replacement: `${pkg('ui')}/$1` },
    ],
  },
  test: {
    include: ['packages/**/*.test.ts'],
    environment: 'node',
    server: { deps: { inline: [/solid-js/] } },
    testTimeout: 120_000,
  },
});
