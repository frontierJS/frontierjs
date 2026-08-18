import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    // `test/browser/` is the other kind of suite: `*.spec.mjs` files driven by
    // a real Chrome from `test/browser/*/run.mjs`, not by vitest. They export
    // `run(t)` rather than declaring a suite, so collecting them here is
    // eleven failures that mean nothing.
    // Spread the defaults rather than replacing them — this key OVERRIDES
    // rather than adds, so a bare list here also un-excludes node_modules.
    exclude: [...configDefaults.exclude, 'test/browser/**'],
  },
})
