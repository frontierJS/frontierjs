/**
 * Two `on:click` on one element (`FJS-885`).
 *
 * A delegated handler is a PROPERTY on the element — `el.__click = fn` — so a
 * second one overwrote the first and it fired never. Silently, and only on that
 * path: the non-delegated branch calls `addEvent`, which appends, so the same
 * markup behaved differently depending on whether the event carried a modifier.
 *
 * Svelte attaches both and fires both (sveltejs/svelte#2688, #128), which is
 * also what the neighbouring path here already did.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { compileSource } from '../src/compiler.js'
import { flushSync, mount } from '../src/runtime.js'

let n = 0
async function render(src) {
  const ctx = await compileSource(src, { filename: `/D${n}.mesa`, dev: false })
  const js = ctx.result.replace(/'@frontierjs\/mesa\/runtime\.js'/g, `'./src/runtime.js'`)
  const file = path.join(process.cwd(), `_dup_${n++}.mjs`)
  writeFileSync(file, js)
  let Comp
  try { Comp = (await import('file://' + file)).default }
  finally { try { unlinkSync(file) } catch {} }

  const wrap = document.createElement('div')
  document.body.appendChild(wrap)
  const label = document.createElement('span')
  wrap.appendChild(label)
  mount(label, Comp, { props: {} })
  flushSync()
  return wrap
}

const click = (wrap, sel = 'button') => { wrap.querySelector(sel).click(); flushSync() }

beforeEach(() => { document.body.innerHTML = ''; globalThis.__hits = [] })

describe('more than one handler for one event', () => {
  it('both run, in the order they were written', async () => {
    const wrap = await render(`<script>
  const first  = () => globalThis.__hits.push('first')
  const second = () => globalThis.__hits.push('second')
</script>
<button on:click={first} on:click={second}>go</button>`)
    click(wrap)
    expect(globalThis.__hits).toEqual(['first', 'second'])
  })

  it('three of them all run', async () => {
    const wrap = await render(`<script>
  const a = () => globalThis.__hits.push('a')
  const b = () => globalThis.__hits.push('b')
  const c = () => globalThis.__hits.push('c')
</script>
<button on:click={a} on:click={b} on:click={c}>go</button>`)
    click(wrap)
    expect(globalThis.__hits).toEqual(['a', 'b', 'c'])
  })

  it('each receives the event', async () => {
    const wrap = await render(`<script>
  const a = (e) => globalThis.__hits.push('a:' + e.type)
  const b = (e) => globalThis.__hits.push('b:' + e.type)
</script>
<button on:click={a} on:click={b}>go</button>`)
    click(wrap)
    expect(globalThis.__hits).toEqual(['a:click', 'b:click'])
  })
})

describe('what must not change', () => {
  it('a single handler still fires exactly once', async () => {
    const wrap = await render(`<script>
  const only = () => globalThis.__hits.push('only')
</script>
<button on:click={only}>go</button>`)
    click(wrap)
    expect(globalThis.__hits).toEqual(['only'])
  })

  it('two different events on one element are independent', async () => {
    const wrap = await render(`<script>
  const onClick = () => globalThis.__hits.push('click')
  const onInput = () => globalThis.__hits.push('input')
</script>
<button on:click={onClick} on:input={onInput}>go</button>`)
    click(wrap)
    expect(globalThis.__hits).toEqual(['click'])
  })

  it('handlers on two different elements stay apart', async () => {
    const wrap = await render(`<script>
  const one = () => globalThis.__hits.push('one')
  const two = () => globalThis.__hits.push('two')
</script>
<div><button id="a" on:click={one}>a</button><button id="b" on:click={two}>b</button></div>`)
    click(wrap, '#a')
    expect(globalThis.__hits).toEqual(['one'])
  })
})

/**
 * An object written into an attribute (`FJS-885`).
 *
 * `set_attribute` decided property-vs-attribute from a fixed list of HTML
 * names, while the spread path next door asked the ELEMENT — so a custom
 * element handed an object got `[object Object]` unless the property happened
 * to be spelled `value`.
 */
import { set_attribute, resetAttributeWarnings } from '../src/runtime.js'

describe('an object handed to an attribute', () => {
  const warnings = (fn) => {
    resetAttributeWarnings()
    const seen = []
    const real = console.warn
    console.warn = (...a) => seen.push(a.join(' '))
    try { fn() } finally { console.warn = real }
    return seen.filter((w) => w.includes('[Mesa]'))
  }

  it('a custom element that declares the property receives the object itself', () => {
    const el = document.createElement('x-card')
    el.payload = null                                  // the element declares it
    const value = { id: 7 }
    expect(warnings(() => set_attribute(el, 'payload', value))).toEqual([])
    expect(el.payload).toBe(value)
    expect(el.getAttribute('payload')).toBeNull()
  })

  it('a custom element that declares nothing is told what happened', () => {
    const el = document.createElement('x-plain')
    const w = warnings(() => set_attribute(el, 'payload', { id: 7 }))
    expect(el.getAttribute('payload')).toBe('[object Object]')
    expect(w.length).toBe(1)
    expect(w[0]).toContain('declares no')
  })

  it('an ordinary element is told too, and still gets the attribute', () => {
    const el = document.createElement('div')
    const w = warnings(() => set_attribute(el, 'data-thing', { id: 7 }))
    expect(el.getAttribute('data-thing')).toBe('[object Object]')
    expect(w.length).toBe(1)
  })

  it('a STRING on a custom element still goes to the attribute', () => {
    // The narrowing that keeps a `[foo="bar"]` selector working.
    const el = document.createElement('x-card')
    el.label = null
    expect(warnings(() => set_attribute(el, 'label', 'hello'))).toEqual([])
    expect(el.getAttribute('label')).toBe('hello')
  })

  it('an object that stringifies meaningfully is not warned about', () => {
    const el = document.createElement('div')
    const when = new Date('2020-01-01T00:00:00Z')
    const w = warnings(() => set_attribute(el, 'data-when', when))
    expect(w).toEqual([])
    // Compared against the value's own stringification rather than a literal:
    // `String(date)` is local time, so a literal here fails in another zone.
    expect(el.getAttribute('data-when')).toBe(String(when))
  })

  it('warns once per element name and attribute, not once per row', () => {
    const w = warnings(() => {
      for (let i = 0; i < 3; i++) set_attribute(document.createElement('div'), 'data-x', { i })
    })
    expect(w.length).toBe(1)
  })
})

// The `xlink:`/`xml:` namespace assertions are NOT here. happy-dom normalizes
// `setAttribute('xlink:href', …)` into the XLink namespace by itself, so the
// fix and its absence are indistinguishable under it and a test would pass for
// the wrong reason. They live in the browser drive, where a real Chrome puts
// that attribute in NO namespace — see `test/browser/runtime/specs/namespaced-attributes.spec.mjs`.
