// import-watch.test.js
//
// An imported object is inert until a `$:` in THIS component watches it (VISION
// RULE 44). What this file pins, in three parts:
//
//   * `$: store, () => f()` — a whole imported object as a handler's dep —
//     registered no watch, so the handler never ran again (`FJS-1339`).
//   * What RULE 47 actually does across components, measured rather than
//     described: VISION states these as facts, and they fail here first.
//   * The reads nothing watches, listed on `analysis.staticReads` and handed to
//     devtools by a dev build (`FJS-1340`).

import { describe, it, expect, beforeEach } from 'vitest'
import { compileSource } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

const tick = () => new Promise((r) => setTimeout(r, 0))

// Compiles with `./store.js` resolved to the object handed in, the way an ESM
// import would share one module instance between components.
async function comp(src, store, opts = {}) {
  const ctx = await compileSource(src, { filename: `/C${Math.random()}.mesa`, dev: false, css: false, ...opts })
  let code = ctx.result.replace(/^import \{ ([^}]+) \} from '\.\/store\.js';$/m, 'const { $1 } = __store;')
  code = code.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
  code = code.replace(/^export default\s+/m, 'const __c = ') + '\nreturn __c'
  return { ctx, Comp: new Function('$$runtime', '__store', code)(runtime, store) }
}

function place(Comp) {
  const a = document.createElement('span')
  document.body.appendChild(a)
  return runtime.mount(a, Comp, {})
}

const text = (sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent).join()

beforeEach(() => { document.body.innerHTML = '' })

describe('a whole imported object as a handler dep', () => {
  it('runs the handler when the object is written through its proxy', async () => {
    const store = { s: { n: 0 }, t: { n: 0 } }
    const log = []
    globalThis.__log = log
    const { Comp } = await comp(`<script>
  import { s, t } from './store.js'
  $: s, () => __log.push('s')
  $: (s, t), () => __log.push('st')
  const d = s.n * 2
</script>
<b class="d">{d}</b>`, store)
    place(Comp)
    await tick()
    runtime.watchProxy(store.s).n = 1
    runtime.flushSync(); await tick()
    expect(log).toEqual(['s', 'st'])
    expect(text('.d')).toBe('2')
    runtime.watchProxy(store.t).n = 1
    runtime.flushSync(); await tick()
    expect(log).toEqual(['s', 'st', 'st'])
  })
})

describe('RULE 47, measured', () => {
  const WATCHER = `<script>\n  import { s } from './store.js'\n  $: s\n</script>\n<i class="w">{s.count}</i>`
  const NONE    = `<script>\n  import { s } from './store.js'\n</script>\n<b class="r">{s.count}</b>`
  const OTHER   = `<script>\n  import { s } from './store.js'\n  $: s.other\n</script>\n<b class="r">{s.count}</b>`

  async function run(reader, order) {
    const store = { s: { count: 0, other: 0 } }
    const W = (await comp(WATCHER, store)).Comp
    const R = (await comp(reader, store)).Comp
    let w
    if (order === 'reader-first') { place(R); await tick(); w = place(W) }
    else { w = place(W); await tick(); place(R) }
    await tick()
    if (order === 'watcher-gone') { w.destroy(); await tick() }
    runtime.watchProxy(store.s).count = 1
    runtime.flushSync(); await tick()
    return text('.r')
  }

  it('never updates a component that watches nothing on the import, in any order', async () => {
    for (const order of ['watcher-first', 'reader-first', 'watcher-gone']) {
      document.body.innerHTML = ''
      expect(await run(NONE, order), order).toBe('0')
    }
  })

  it('covers a component watching another path only if the watch existed when it mounted', async () => {
    expect(await run(OTHER, 'watcher-first')).toBe('1')
    document.body.innerHTML = ''
    expect(await run(OTHER, 'reader-first')).toBe('0')
  })

  it('keeps that cover after the component declaring the watch is destroyed', async () => {
    expect(await run(OTHER, 'watcher-gone')).toBe('1')
  })
})

describe('imported reads nothing here watches', () => {
  const SCRATCH = `<script>
  import { stateObject, statePrimitive } from './store.js'
  import Child from './Child.mesa'
  import { fmt, lib } from 'some-lib'
  const doubled = stateObject.count * 2
  const doubledWrong = statePrimitive * 2
  const onPick = () => stateObject.count
  var snap = stateObject.count
</script>
<h1>{doubled} {stateObject.count} {fmt(snap)} {lib.go(1)}</h1>
<button on:click={stateObject.reset}>x</button>
<Child />`

  const reads = async (src, opts) =>
    (await compileSource(src, { filename: '/S.mesa', dev: false, css: false, ...opts })).analysis.staticReads ?? []

  it('lists a template read and a const built from one', async () => {
    expect(await reads(SCRATCH)).toEqual([
      { path: 'stateObject.count', where: 'template',      from: './store.js', watchedHere: false },
      { path: 'stateObject.count', where: 'const doubled', from: './store.js', watchedHere: false },
    ])
  })

  it('leaves out a call, a handler, a function const, a var and a bare primitive', async () => {
    const paths = (await reads(SCRATCH)).map((r) => `${r.where}:${r.path}`)
    for (const not of ['stateObject.reset', 'lib.go', 'fmt', 'const onPick', 'var snap', 'statePrimitive'])
      expect(paths.join(' ')).not.toContain(not)
  })

  it('counts a handler dep as a watch, so a covered read is neither listed nor warned', async () => {
    const src = `<script>
  import { s } from './store.js'
  $: s.count, () => {}
</script>
<p>{s.count} {s.other}</p>`
    const ctx = await compileSource(src, { filename: '/S.mesa', dev: false, css: false, externalReactivityHints: 'strict', warning: () => {} })
    expect(ctx.analysis.staticReads).toEqual([{ path: 's.other', where: 'template', from: './store.js', watchedHere: true }])
    const warned = ctx.analysis.warnings.filter((w) => /watch covers it/.test(w))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toMatch(/'s\.other'/)
  })

  it('names the const in the strict warning when only a const reads it', async () => {
    const ctx = await compileSource(`<script>
  import { s } from './store.js'
  const d = s.n * 2
</script>
<p>{d}</p>`, { filename: '/S.mesa', dev: false, css: false, externalReactivityHints: 'strict', warning: () => {} })
    expect(ctx.analysis.warnings.join('\n')).toMatch(/'s\.n' is read by 'const d' but no '\$: s\.n' watch covers it/)
  })

  it('hands the list to devtools in a dev build, and emits nothing extra otherwise', async () => {
    const dev = await compileSource(SCRATCH, { filename: '/S.mesa', dev: true, css: false })
    expect(dev.result).toMatch(/push_component\('S', '\/S\.mesa', \[\{"path":"stateObject\.count","where":"template","watchedHere":false\}/)
    const prod = await compileSource(SCRATCH, { filename: '/S.mesa', dev: false, css: false })
    expect(prod.result).toMatch(/push_component\(\);/)
    const clean = await compileSource(`<script>\n  let n = 0\n</script>\n<p>{n}</p>`, { filename: '/K.mesa', dev: true, css: false })
    expect(clean.result).toMatch(/push_component\('K', '\/K\.mesa'\);/)
  })

  it('reaches the component record devtools reads', async () => {
    const store = { stateObject: { count: 1 }, statePrimitive: 1 }
    const { Comp } = await comp(`<script>
  import { stateObject } from './store.js'
</script>
<p>{stateObject.count}</p>`, store, { dev: true })
    place(Comp)
    const recs = [...runtime.__dev._components.values()]
    expect(recs.at(-1).statics).toEqual([{ path: 'stateObject.count', where: 'template', watchedHere: false }])
  })
})
