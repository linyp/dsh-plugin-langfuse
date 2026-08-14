import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.e2e.ts'],
    // The REAL-composition tier boots a full harness app as a subprocess.
    testTimeout: 120_000,
  },
})
