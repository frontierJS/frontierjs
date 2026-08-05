import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals:     false,
    testTimeout: 30000,
    // pool:forks runs tests in a real Node child process, bypassing Vite's
    // module graph transform. Required because render-component.js uses
    // dynamic import() of temp .mjs files and needs real Node module resolution.
    pool: 'forks',
  }
})
