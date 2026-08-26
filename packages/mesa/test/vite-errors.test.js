// vite-errors.test.js
//
// The compiler REPORTS and the build DECIDES (VISION RULE 53): `compileSource`
// collects into `analysis.errors` and throws only on a parse failure, so a
// plugin reading `warnings` alone serves a half-compiled module for every fault
// the compiler did catch — a `bind:` on a non-`let`, an inert `$: { }`. The page
// renders, looks right, and writes nothing back.
//
// Sierra's plugin has failed the transform on `analysis.errors` since 2026-08-05
// (DECISIONS § UI substrate). This asserts Mesa's own plugin agrees, in both
// modes: a build fails through `this.error`, dev returns a module that throws so
// Vite's overlay fires.

import { describe, test, expect } from 'vitest'
import mesaPlugin from '../mesa-vite/index.js'

const INERT = '<script>\nlet a = 1, b = 2\n$: { (a, b) }\n</script><p>{a}</p>'
const CLEAN = '<script>\nlet a = 1\n</script><p>{a}</p>'

async function transform(command, source) {
  const plugin = mesaPlugin({ hmr: false })
  plugin.configResolved({ root: '/t', command })

  const reported = []
  const self = {
    error: (e) => { reported.push(e); throw Object.assign(new Error(e.message), e) },
    warn:  () => {}
  }

  try {
    const out = await plugin.transform.call(self, source, '/t/T.mesa')
    return { code: out?.code ?? null, reported }
  } catch (e) {
    return { threw: e, reported }
  }
}

describe('the vite plugin fails on compiler errors', () => {

  test('a build reports through this.error and emits nothing', async () => {
    const r = await transform('build', INERT)
    expect(r.code).toBeUndefined()
    expect(r.reported).toHaveLength(1)
    expect(r.reported[0].message).toContain('1 error(s) in T.mesa')
    expect(r.reported[0].message).toContain('does nothing')
    expect(r.reported[0].plugin).toBe('mesa')
  })

  test('dev emits a throwing module so the overlay fires', async () => {
    const r = await transform('serve', INERT)
    expect(r.threw).toBeUndefined()
    expect(r.code).toMatch(/^throw new Error\(/)
    expect(r.code).toContain('does nothing')
    // The message is interpolated into a template literal — an unescaped
    // backtick from a diagnostic would close it and ship a syntax error.
    expect(() => new Function(r.code)).not.toThrow()
  })

  test('a clean component still compiles in both modes', async () => {
    for (const command of ['build', 'serve']) {
      const r = await transform(command, CLEAN)
      expect(r.reported).toHaveLength(0)
      expect(r.code).toContain('$$runtime.template')
    }
  })
})
