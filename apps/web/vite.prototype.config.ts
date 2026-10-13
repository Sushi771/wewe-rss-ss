import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Isolated entry: no registration in App.tsx and no proxy/server configuration.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(
      __dirname,
      '../../output/subscription-implementation/challenge-20261005/paid-prototype-dist',
    ),
    emptyOutDir: false,
    modulePreload: false,
    rollupOptions: {
      input: resolve(__dirname, 'paid-prototype.html'),
      output: { inlineDynamicImports: true },
    },
  },
});
