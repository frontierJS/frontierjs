/**
 * test/transform-logs.test.js
 *
 * What the mesa plugin's `transform` hands Vite when the compiler has something
 * to say (`FJS-1903`).
 *
 * Under `bun --bun vite`, every warning about a `.mesa` file was placed at
 * `<file>:8766:43`, whatever the file's length: handed a string, Vite builds
 * `new Error(message)`, and Bun's `Error` carries `line` and `column` — where it
 * was constructed, inside Vite — which Vite then reports as a place in the file
 * being transformed. A thrown compile failure landed on the same line.
 *
 * vitest runs on Node, whose `Error` has no `line`, so a context that merely
 * records what it is handed would pass against the bug. `viteCtx` applies the
 * rule Vite's `_formatLog` does, under Bun.
 *
 * And every analysis warning printed twice: once through the compiler's default
 * `warning` callback, straight to the console, and once through `this.warn`,
 * while a warning only that callback carries reached the console alone.
 */

import { describe, test, expect, beforeAll, vi } from 'vitest'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mesaPlugin } from '../src/build/mesa-plugin.js'

const SIERRA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ID = `${SIERRA_ROOT}/src/components/__Probe.mesa`

// `cfg.title` is a member read of an import with no `$:` watch, which Sierra's
// strict reactivity hints report.
const WARNS = "<script>\nimport { cfg } from './cfg.js'\n</script>\n<p>{cfg.title}</p>\n"
// A block split across slots is reported through the callback alone; it never
// lands on `ctx.analysis.warnings`.
const SLOTS = '<script>\nimport Card from \'./Card.mesa\'\nlet x = true\n</script>\n' +
  '<Card>{#if x}<span slot="a">a</span>text{/if}</Card>\n'
const FAILS = '<script>\nlet a = 1, b = 2\n$: { (a, b) }\n</script><p>{a}</p>\n'

let plugin

beforeAll(async () => {
  plugin = mesaPlugin({}, {
    root:          SIERRA_ROOT,
    autoImportMap: new Map(),
    staticMap:     new Map(),
    layoutPropMap: new Map(),
  })
  plugin.configResolved({ root: SIERRA_ROOT, command: 'build', mode: 'production' })
  await plugin.buildStart.call({})
})

// Vite's `_formatLog` under Bun: a string becomes an Error that knows a line.
const asVite = (log) => {
  const err = typeof log === 'string' ? Object.assign(new Error(log), { line: 8766, column: 43 }) : log
  return { message: err.message, line: err.line, column: err.column }
}

const viteCtx = () => {
  const warnings = []
  return {
    warnings,
    addWatchFile() {},
    warn(log) { warnings.push(asVite(log)) },
    error(log) { throw Object.assign(new Error('vite'), { log: asVite(log) }) },
  }
}

describe('transform logs', () => {
  test('a compiler warning carries no position it does not have', async () => {
    const ctx = viteCtx()
    await plugin.transform.call(ctx, WARNS, ID)

    const mine = ctx.warnings.filter((w) => w.message.includes('cfg.title'))
    expect(mine).toHaveLength(1)
    expect(mine[0].line).toBeUndefined()
    expect(mine[0].column).toBeUndefined()
  })

  test('a compile failure carries no position it does not have', async () => {
    const ctx = viteCtx()
    const thrown = await plugin.transform.call(ctx, FAILS, ID).catch((e) => e)

    expect(thrown.log.message).toContain('Mesa compilation failed')
    expect(thrown.log.line).toBeUndefined()
  })

  test('a warning is said once, to Vite, and not to the console', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ctx = viteCtx()
      await plugin.transform.call(ctx, WARNS, ID)
      expect(spy).not.toHaveBeenCalled()
      expect(ctx.warnings.filter((w) => w.message.includes('cfg.title'))).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  test('a warning only the callback carries reaches Vite', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ctx = viteCtx()
      await plugin.transform.call(ctx, SLOTS, ID)
      const mine = ctx.warnings.filter((w) => w.message.includes('mixes slotted and unslotted'))
      expect(mine).toHaveLength(1)
      expect(mine[0].message).toMatch(/^\[Mesa\] a \{#if\}/)
    } finally {
      spy.mockRestore()
    }
  })
})
