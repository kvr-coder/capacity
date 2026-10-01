import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Base path is overridable so the same build can serve from a GitHub Pages
// subpath (`/capacity/`) or from a domain root.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    // The engine worker is an ES module; without this Vite emits an IIFE that
    // cannot use `import`, and the worker fails at runtime rather than at build.
    format: 'es',
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
