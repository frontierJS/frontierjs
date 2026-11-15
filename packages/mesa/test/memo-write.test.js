// memo-write.test.js
//
// A write while a value computes (`FJS-4291`, ruled `FJS-D1367`). A derived
// `const` that writes a signal is refused: a compile error where the compiler
// sees the write, a dev throw where it does not (a call). A `$:` that writes
// a signal it reads warns, unless a test of that signal guards the write. The
// cycle cap names the `$:` line and the write that woke it.
//
// The runtime's dev switch latches on for the module the first time a dev
// build registers a signal, so the production-build case runs first.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as acorn from 'acorn'
import { compileSource } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

const { track, set, get, createMemo, createEffect, createRoot, watchProxy, flushSync, __dev } = runtime

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => { runtime.flushSync(); await tick(); runtime.flushSync() }

async function compile(script, markup = '<p></p>', dev = false) {
  return compileSource(`<script>\n${script}\n</script>\n${markup}`,
    { filename: `/C${Math.random().toString(36).slice(2, 8)}.mesa`, dev, css: false, loc: false })
}

async function mount(script, markup, dev) {
  const ctx = await compile(script, markup, dev)
  if (ctx.analysis.errors.length) throw new Error(ctx.analysis.errors[0])
  acorn.parse(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })
  const code = ctx.result.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
    .replace(/^export default\s+/m, 'const __c = ') + '\nreturn __c'
  const Comp = new Function('$$runtime', code)(runtime)
  const host = document.createElement('div')
  const anchor = document.createElement('span')
  host.appendChild(anchor)
  document.body.appendChild(host)
  runtime.mount(anchor, Comp, {})
  await settle()
  return host
}

let errors
beforeEach(() => {
  document.body.innerHTML = ''
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => errors.mockRestore())

describe('a production build does not check a memo write', () => {
  it('a memo writing a signal and a store goes through', () => {
    createRoot(() => {
      const b = track(0)
      const p = watchProxy({ log: 0 })
      const m = createMemo(() => { set(b, 3); p.log = 4; return 1 })
      expect(m()).toBe(1)
      expect(get(b)).toBe(3)
      expect(p.log).toBe(4)
    })
  })
})

describe('a derived const that writes a let (compile)', () => {
  it('is refused, naming both', async () => {
    const ctx = await compile('let a = 0\nlet b = 0\nconst c = (b = a + 1, a * 2)', '<p>{c}{b}</p>')
    expect(ctx.analysis.errors.length).toBe(1)
    expect(ctx.analysis.errors[0]).toContain("'c' is a derived 'const', and its initializer writes 'b'")
    expect(ctx.analysis.errors[0]).toMatch(/\.mesa:4:\d+$/)
  })

  it('a write inside a callback the initializer hands out is not a write while it computes', async () => {
    const ctx = await compile('let a = 0\nlet b = 0\nconst api = { a, bump: () => b++ }', '<p>{api.a}{b}</p>')
    expect(ctx.analysis.errors).toEqual([])
  })
})

describe('a $: that writes what it reads (compile)', () => {
  const warned = async (script) => (await compile(script)).analysis.warnings
    .filter((w) => w.includes('which it also'))

  it('warns on an unguarded write to what it watches, reads or clamps', async () => {
    expect(await warned('let n = 0\n$: n, () => { n = n + 1 }')).toHaveLength(1)
    expect(await warned('let n = 0\n$: { n = n + 1 }')).toHaveLength(1)
    expect((await warned('let n = 0\n$: { n = Math.min(n, 10) }'))[0])
      .toContain("This '$:' writes 'n', which it also reads")
  })

  it('a write it does not read, or one shadowed by a local, says nothing', async () => {
    expect(await warned('let a = 0\nlet n = 0\n$: { n = a + 1 }')).toEqual([])
    expect(await warned('let a = 0\nlet n = 0\n$: { let n = a; n = n + 1; console.log(n) }')).toEqual([])
  })

  it('a read after the write sees the value the block just computed, and says nothing', async () => {
    expect(await warned('let list = {}\nlet refused = false\nlet error = null\n' +
      '$: {\n  const e = list.error\n  refused = e?.code === 403\n  error = e && !refused ? e.message : null\n}')).toEqual([])
  })

  it('a previous-value tracker reads before it writes, and warns', async () => {
    expect(await warned('let on = false\nlet was = false\n$: {\n  if (was && !on) console.log(1)\n  was = on\n}'))
      .toHaveLength(1)
  })

  // The corpus's three test-then-write `$:`, verbatim in shape.
  it.each([
    ['ui Form.mesa record default', 'export let record = undefined\nlet seed = {}\n$: { if (record === undefined) record = seed }', '<p>{record}</p>'],
    ['basecamp projects/create.mesa serverId', "let serverId = ''\nlet online = []\n$: { if (!serverId && online.length === 1) serverId = online[0].id }", '<p>{serverId}</p>'],
    ['vellum review/index.mesa restored', 'let restored = false\nlet queue = { loading: false }\nfunction restore() {}\n$: {\n  if (!restored && !queue.loading) {\n    restored = true\n    restore()\n  }\n}', '<p>{restored}</p>'],
  ])('%s does not warn, and its output parses', async (_, script, markup) => {
    const ctx = await compile(script, markup)
    expect(ctx.analysis.errors).toEqual([])
    expect(ctx.analysis.warnings.filter((w) => w.includes('which it also'))).toEqual([])
    acorn.parse(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })
  })
})

describe('a memo write in a dev build (runtime)', () => {
  const dev = () => {
    const b = track(0)
    __dev.r(b, 'b', 'let')
    return b
  }

  it('throws at the write, naming the memo and the signal', () => {
    createRoot(() => {
      const b = dev()
      const a = track(1)
      const c = runtime.trackDerived(() => { set(b, get(a)); return get(a) * 2 })
      __dev.r(c, 'c', 'derived')
      expect(() => get(c)).toThrow(/'c' wrote 'b' while it computed/)
      expect(get(b)).toBe(0)
    })
  })

  it('a store write from a memo throws, naming the path', () => {
    createRoot(() => {
      dev()
      const p = watchProxy({ n: 1, log: 0 })
      expect(() => createMemo(() => { p.log = p.n * 2; return p.n })()).toThrow(/wrote 'log' while it computed/)
    })
  })

  it('a write from an effect, or from a derived-tier effect, is not refused', () => {
    createRoot(() => {
      const b = dev()
      const a = track(2)
      createEffect(() => { set(b, get(a) + 1) })
      flushSync()
      expect(get(b)).toBe(3)
      createEffect(() => { set(b, get(a) + 5) }, { derived: true })
      flushSync()
      expect(get(b)).toBe(7)
    })
  })

  it('a compiled derived const reaching a write through a call is refused at runtime', async () => {
    await expect(mount('let a = 1\nlet b = 0\nfunction compute(x) { b = x; return x * 2 }\nconst c = compute(a)',
      '<p>{c}</p><i>{b}</i>', true)).rejects.toThrow("'c' wrote 'b' while it computed")
  })
})

describe('the cycle cap in a dev build', () => {
  it('names the $: line and the signal written', async () => {
    const ctx = await compile('let a = 0\nlet b = 0\n$: { a = b + 1 }\n$: { b = a + 1 }', '<p>{a}</p>', true)
    expect(ctx.result).toMatch(/loc: "\/C\w+\.mesa:4:\d+"/)
    await mount('let a = 0\nlet b = 0\n$: { a = b + 1 }\n$: { b = a + 1 }', '<p>{a}</p>', true)
    const cycle = errors.mock.calls.map((c) => String(c[0])).find((m) => m.includes('Update cycle'))
    expect(cycle).toMatch(/at \/C\w+\.mesa:[45]:\d+ ran 100 times/)
    expect(cycle).toMatch(/last woken by a write to `[ab]`/)
  })
})
