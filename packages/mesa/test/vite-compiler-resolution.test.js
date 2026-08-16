// @vitest-environment node

/**
 * vite-compiler-resolution.test.js — how the plugin finds a compiler, and what
 * it does with output only a different compiler could produce.
 *
 * Resolution is the one thing here with a known history: as its own package the
 * plugin hunted `@mesa/compiler` and `node_modules/mesa/`, one a name that was
 * never published and the other someone else's package on npm, so it could not
 * find its own compiler at all (FJS-024). It is a sibling now, and this pins
 * both halves — the sibling is found with no configuration, and `compilerPath`
 * still wins for a caller testing a build that is not this one.
 *
 * The answer is memoised in a MODULE-level variable, so every case resets the
 * module registry first: one resolution decides for the whole process, and a
 * test inheriting the previous test's compiler proves nothing.
 *
 * The stub is also how the diagnostics below are reached. The plugin defends
 * against a warning containing a newline and an error carrying `details`; no
 * compiler output today has either, so without a stub those branches are
 * unreachable and the defence is untested until the day it matters.
 */

import { describe, test, expect, vi } from 'vitest'
import { parse }                      from 'acorn'
import { fileURLToPath }              from 'node:url'

const STUB = fileURLToPath(new URL('./fixtures/stub-compiler.mjs', import.meta.url))
const ROOT = '/app'

/** A plugin from a FRESH module registry — see the note about memoisation. */
async function freshPlugin(options = {}, command = 'serve') {
  vi.resetModules()
  const { default: mesaPlugin } = await import('../mesa-vite/index.js')

  const plugin = mesaPlugin(options)
  plugin.configResolved({ root: ROOT, command })
  return plugin
}

/** Call transform() with a stand-in for Vite's plugin context. */
async function transform(plugin, source, id = `${ROOT}/A.mesa`) {
  const warnings = []
  const errors   = []
  const self     = {
    warn:  (w) => warnings.push(typeof w === 'string' ? w : w.message),
    error: (e) => { errors.push(e); throw Object.assign(new Error(e.message), e) }
  }

  try {
    const out = await plugin.transform.call(self, source, id)
    return { out, code: out?.code ?? null, warnings, errors, threw: null }
  } catch (threw) {
    return { out: null, code: null, warnings, errors, threw }
  }
}

const parses = (js) =>
  expect(() => parse(js, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()

// ─── resolution ───────────────────────────────────────────────────────────────

describe('finding the compiler', () => {
  test('the sibling is found with no configuration at all', async () => {
    const plugin = await freshPlugin({ hmr: false })
    const { code } = await transform(plugin, '<script>\nlet a = 1\n</script><p>{a}</p>')

    expect(code).toContain('$runtime.template')
  })

  test('compilerPath wins over the sibling', async () => {
    const plugin   = await freshPlugin({ compilerPath: STUB, hmr: false })
    const { code } = await transform(plugin, JSON.stringify({ result: 'export const from = "stub"' }))

    expect(code).toContain('export const from = "stub"')
  })

  test('a compilerPath that does not exist falls back to the sibling', async () => {
    const plugin   = await freshPlugin({ compilerPath: '/nope/compiler.js', hmr: false })
    const { code } = await transform(plugin, '<script>\nlet a = 1\n</script><p>{a}</p>')

    expect(code).toContain('$runtime.template')
  })

  // The memo is per module instance, not per plugin instance. Two plugins in one
  // Vite config — a `widget` build beside an app build, say — share whichever
  // compiler was asked for first, and the second one's compilerPath is silently
  // ignored.
  test('the first resolution decides for every later plugin instance', async () => {
    vi.resetModules()
    const { default: mesaPlugin } = await import('../mesa-vite/index.js')

    const first = mesaPlugin({ compilerPath: STUB, hmr: false })
    first.configResolved({ root: ROOT, command: 'serve' })
    await transform(first, JSON.stringify({ result: 'export const from = "stub"' }))

    const second = mesaPlugin({ hmr: false })       // wants the sibling
    second.configResolved({ root: ROOT, command: 'serve' })
    const { code } = await transform(second, JSON.stringify({ result: 'export const from = "stub"' }))

    expect(code).toContain('export const from = "stub"')
  })
})

// ─── diagnostics only another compiler can produce ────────────────────────────

describe('diagnostics the real compiler cannot reach', () => {
  test('a multi-line warning is flattened, so the module still parses', async () => {
    const plugin   = await freshPlugin({ compilerPath: STUB, hmr: false })
    const { code } = await transform(plugin, JSON.stringify({
      warnings: ['first line\nsecond line'],
      result:   'export default function Stub() {}',
    }))

    // Without the flatten, `second line` lands outside the comment and is code.
    expect(code).toContain('// ⚠ Mesa: first line second line')
    parses(code)
  })

  test('a parse error with details becomes the overlay frame', async () => {
    const plugin = await freshPlugin({ compilerPath: STUB, hmr: false })

    const sent = []
    await plugin.handleHotUpdate({
      file:    `${ROOT}/A.mesa`,
      modules: [],
      read:    async () => JSON.stringify({
        throw: { message: 'Unexpected token', details: '<button onclick={() =>}>' }
      }),
      server:  { hot: { send: (m) => sent.push(m) }, moduleGraph: {} },
    })

    expect(sent[0].err.message).toBe('Unexpected token')
    expect(sent[0].err.frame).toBe('<button onclick={() =>}>')
  })

  test('a frame is escaped before it is inlined into a dev module', async () => {
    const plugin = await freshPlugin({ compilerPath: STUB, hmr: false })
    const { code } = await transform(plugin, JSON.stringify({
      throw: { message: 'bad `tick`', details: 'const s = `${x}`' }
    }))

    // The throw is built as a template literal. An unescaped backtick from a
    // diagnostic closes it and ships a syntax error in place of the error.
    expect(code).toMatch(/^throw new Error\(/)
    parses(code)
  })
})

// ─── an extracted stylesheet has no reader ────────────────────────────────────

describe('a compiler that extracts CSS instead of inlining it', () => {
  // FJS-291. The plugin used to answer `ctx.css.result` with a `?mesa-css`
  // virtual module, under a condition no compiler could satisfy; that route is
  // gone and inlining is the only one. What is left is the pass-through, and
  // this pins the consequence: a compiler that hands back an extracted
  // stylesheet is handing it to nobody.
  test('the stylesheet is ignored, and no id is invented for it', async () => {
    const plugin   = await freshPlugin({ compilerPath: STUB, hmr: false })
    const { code } = await transform(plugin, JSON.stringify({ css: 'p { color: red }' }))

    expect(code).not.toContain('mesa-css')
    expect(code).not.toContain('color: red')
    expect(plugin.resolveId(`${ROOT}/A.mesa?mesa-css`)).toBeNull()
    parses(code)
  })
})
