import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      pierreangulaire: resolve(import.meta.dirname, '../src/index.ts'),
    },
  },
});
