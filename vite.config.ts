import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
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
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
