/**
 * FJS-D212 — a `const` is derived only when something it names can move.
 *
 * `reactiveSet` was every top-level binding whose `kind !== 'var'`, so a `const`
 * over static `const`s was promoted to `trackDerived` too. The cost is not the
 * wasted memo: promotion makes the initializer LAZY, so
 * `const handle = subscribe(id)` never subscribed when nothing read `handle`.
 * That side effect is the headline case here and it is asserted at runtime,
 * because emitted text says nothing about whether a call happened.
 */

import { describe, it, expect } from 'vitest'
import { compile } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

const cx = src => compile(src, { debug: false, css: false }).then(c => c.result)

// Mirrors compiler.test.js's exec helper — a compiled module is a function of
// $$runtime plus whatever it imports.
function execCompiled(code, mock = {}) {
  const importNames = [], importValues = []
  for (const m of code.matchAll(/^import\s+\{([^}]+)\}\s+from\s+'[^']+';$/gm)) {
    m[1].split(',').forEach(spec => {
      const [o, a] = spec.split(/\s+as\s+/)
      importNames.push((a || o).trim())
      importValues.push(mock[o.trim()])
    })
  }
  code = code.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
  code = code.replace(/^export default\s+/m, 'const __component = ')
  code += '\nreturn __component'
  return new Function('$$runtime', ...importNames, code)(runtime, ...importValues)
}

// Mounted inside a createRoot so registerComponentAnchor finds an owner —
// pushProps is the only lever here that can move a value, since happy-dom has
// no delegation root and a handler-driven write is unobservable.
async function mount(src, mock = {}, props = {}) {
  const ctx = await compile(src, { debug: false, css: false })
  if (ctx.analysis.errors.length) throw new Error(ctx.analysis.errors[0])
  const Component = execCompiled(ctx.result, mock)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const anchor = document.createComment('')
  container.appendChild(anchor)
  runtime.createRoot(() => {
    Component(anchor, props, null)
    runtime.registerComponentAnchor(anchor)
  })
  runtime.flushSync()
  return {
    text: () => container.textContent,
    push(next) { runtime.pushProps(anchor, next); runtime.flushSync() }
  }
}

// ─── the side effect ─────────────────────────────────────────────────────────

describe('a const whose initializer has a side effect (FJS-D212)', () => {
  const src = `<script>
  import { subscribe } from './api'
  const channelId = 'orders'
  const handle = subscribe(channelId)
</script>
<p>hello</p>`

  it('runs the initializer even though nothing reads the const', async () => {
    const calls = []
    await mount(src, { subscribe: id => { calls.push(id); return { id } } })
    expect(calls).toEqual(['orders'])
  })

  it('is emitted as a plain const, not a lazy memo', async () => {
    const out = await cx(src)
    expect(out).toMatch(/const handle = subscribe\(channelId\)/)
    expect(out).not.toMatch(/const handle = \$\$runtime\.trackDerived/)
  })
})

// ─── the transitive closure ──────────────────────────────────────────────────

describe('promotion is transitive over what can move (FJS-D212)', () => {
  const src = `<script>
  export let page = 1
  const a    = 1
  const b    = a
  const c    = b + page
  const rows = 'p' + page
</script>
<p>{c}|{rows}</p>`

  it('leaves a static const chain alone', async () => {
    const out = await cx(src)
    expect(out).toMatch(/const a = 1/)
    expect(out).toMatch(/const b = a/)
    expect(out).not.toMatch(/const a = \$\$runtime\.trackDerived/)
    expect(out).not.toMatch(/const b = \$\$runtime\.trackDerived/)
  })

  it('promotes the const that reaches the let', async () => {
    const out = await cx(src)
    expect(out).toMatch(/const c = \$\$runtime\.trackDerived/)
  })

  it('a promoted const still recomputes when the let moves', async () => {
    const m = await mount(src)
    expect(m.text()).toBe('2|p1')
    m.push({ page: 5 })
    expect(m.text()).toBe('6|p5')
  })
})

// ─── the roots that can move ─────────────────────────────────────────────────

describe('every movable root promotes a const that names it (FJS-D212)', () => {
  it('a mutable prop does', async () => {
    const out = await cx(`<script>
  export let n = 1
  const doubled = n * 2
</script>
<p>{doubled}</p>`)
    expect(out).toMatch(/const doubled = \$\$runtime\.trackDerived/)
  })

  // export const is a signal too (FJS-D209) — the parent can push a later value,
  // so a const over it is not frozen at mount.
  it('a read-only prop does', async () => {
    const out = await cx(`<script>
  export const n = 1
  const doubled = n * 2
</script>
<p>{doubled}</p>`)
    expect(out).toMatch(/const doubled = \$\$runtime\.trackDerived/)
  })

  it('a watched import does', async () => {
    const out = await cx(`<script>
  import { theme } from './theme'
  const mode = theme.mode
  $: theme.mode
</script>
<p>{mode}</p>`)
    expect(out).toMatch(/const mode = \$\$runtime\.trackDerived/)
  })

  it('an awaited const does', async () => {
    const out = await cx(`<script>
  const data = await load()
  const first = data[0]
</script>
<p>{first}</p>`)
    expect(out).toMatch(/const first = \$\$runtime\.trackDerived/)
  })

  it('an export var does not — it is a snapshot at mount', async () => {
    const out = await cx(`<script>
  export var n = 1
  const doubled = n * 2
</script>
<p>{doubled}</p>`)
    expect(out).not.toMatch(/const doubled = \$\$runtime\.trackDerived/)
  })
})

// ─── a computed member is a read ─────────────────────────────────────────────

describe('a computed member names a variable (FJS-D212)', () => {
  // collectRefs skipped every MemberExpression `property`, computed included,
  // so `users[userId]` looked like it read only `users`. Blanket const
  // promotion hid it: the memo existed and simply had the wrong dep list.
  const src = `<script>
  export let id = 1
  const users = { 1: 'Alice', 2: 'Bob' }
  const user = users[id]
</script>
<p>{user}</p>`

  it('recomputes when the index moves', async () => {
    const m = await mount(src)
    expect(m.text()).toBe('Alice')
    m.push({ id: 2 })
    expect(m.text()).toBe('Bob')
  })

  it('a non-computed member is still a name, not a ref', async () => {
    const out = await cx(`<script>
  const id = 1
  const obj = { id: 9 }
  const v = obj.id
</script>
<p>{v}</p>`)
    expect(out).not.toMatch(/const v = \$\$runtime\.trackDerived/)
  })
})

/*
 * The half the closure cannot see (FJS-D212, amended).
 *
 * `useStore` hands back a getter, so a const holding one is an ordinary
 * function and a const CALLING it reads a signal inside the call — a
 * dependency with no name for the closure to walk. Blanket promotion covered
 * this by accident through runtime auto-tracking; the narrowing dropped it and
 * `example`'s catalogue computed its price ceiling once against an empty store.
 * Every unit suite stayed green, which is why the pair below is here.
 */
import { describe as d2, it as i2, expect as e2 } from 'vitest'
import { compileSource as cs2 } from '../src/compiler.js'

const emit = async (script) => (await cs2(
  `<script>\n${script}\n</script><p>{out}</p>`,
  { filename: '/t/T.mesa', dev: false, css: false }
)).result

d2('a const whose initializer calls a local binding', () => {
  i2('is derived, because what the call reads is decided at runtime', async () => {
    const js = await emit(`const rows = makeGetter()\n  const out = Math.max(0, ...rows().map(x => x))`)
    e2(js).toMatch(/const out = \$\$runtime\.trackDerived/)
  })

  // The control, and it is the whole point: an IMPORTED function is not that
  // door — EXTERNAL_REACTIVITY.md already requires outside state to be declared
  // — so this one stays eager and keeps its side effect.
  i2('an imported call over static values stays eager', async () => {
    const js = await emit(`import { subscribe } from './s.js'\n  const id = 'orders'\n  const out = subscribe(id)`)
    e2(js).toMatch(/const out = subscribe\(id\)/)
    e2(js).not.toMatch(/const out = \$\$runtime\.trackDerived/)
  })

  i2('a call-free static const is still eager', async () => {
    const js = await emit(`const base = '/api'\n  const out = base + '/orders'`)
    e2(js).toMatch(/const out = base \+ '\/orders'/)
  })
})
