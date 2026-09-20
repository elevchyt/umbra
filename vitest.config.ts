import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Match the workspace `exports` map so tests import the same specifiers as the app.
      { find: /^@umbra\/core\/(.*)$/, replacement: `${pkg('core')}/$1.ts` },
      { find: '@umbra/core', replacement: `${pkg('core')}/index.ts` },
      { find: /^@umbra\/engine\/(.*)$/, replacement: `${pkg('engine')}/$1.ts` },
      { find: '@umbra/engine', replacement: `${pkg('engine')}/index.ts` },
      { find: /^@umbra\/psd\/(.*)$/, replacement: `${pkg('psd')}/$1.ts` },
      { find: '@umbra/psd', replacement: `${pkg('psd')}/index.ts` },
    ],
  },
  test: {
    include: ['packages/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
