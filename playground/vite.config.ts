import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      pierreangulaire: resolve(import.meta.dirname, '../src/index.ts'),
    },
  },
});
