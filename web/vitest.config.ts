/**
 * Test-only config, kept separate so vite.config.ts (dev server / proxy)
 * stays untouched. When vitest.config.ts exists Vitest ignores
 * vite.config.ts entirely, so the '@' alias is re-declared here.
 */
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    // Pure functions under test — no DOM needed.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
