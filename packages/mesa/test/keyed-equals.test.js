/**
 * keyed-equals.test.js
 *
 * `selected === row.id` in a thousand-row `{#each}` re-ran a thousand
 * comparisons to move one class (`FJS-1332`). Two halves pin the fix:
 *
 *  - `createKeyedEquals` subscribes a reader to the KEY it asked about, so a
 *    write wakes the readers of the old value and the new one and no others.
 *  - The compiler rewrites that comparison inside a row to one, so the author
 *    who writes `===` gets it. The lift is only safe where the lifted side
 *    means the same thing outside the row, so half of these are the shapes it
 *    must leave alone — a lift that fires where it should not is a wrong
 *    answer, and one that does not fire is only the old cost.
 *
 * The mount test counts reads through a wrapped runtime rather than asserting
 * DOM: the DOM work is identical with and without the lift, so a DOM assertion
 * passes against the bug.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import * as acorn from 'acorn'
import { compileSource } from '../src/compiler.js'
import { createSignal, createEffect, createKeyedEquals, createRoot, flushSync, mount } from '../src/runtime.js'

// ─── runtime ────────────────────────────────────────────────────────────────

function rows(n, sel) {
  const runs = new Array(n).fill(0)
  let is, dispose
  createRoot((d) => {
    dispose = d
    is = createKeyedEquals(sel)
    for (let i = 0; i < n; i++) createEffect(() => { is(i); runs[i]++ })
  })
  runs.fill(0)
  return { runs, is, dispose }
}

describe('createKeyedEquals', () => {
  it('a write wakes the old key and the new one, and nothing else', () => {
    const [sel, setSel] = createSignal(0)
    const { runs, dispose } = rows(100, sel)
    setSel(40); flushSync()
    expect(runs.reduce((a, b) => a + b)).toBe(2)
    expect(runs[0]).toBe(1)
    expect(runs[40]).toBe(1)
    runs.fill(0)
    setSel(40); flushSync()
    expect(runs.reduce((a, b) => a + b)).toBe(0)
    dispose()
  })

  it('answers with ===', () => {
    const [sel, setSel] = createSignal(3)
    const is = createRoot(() => createKeyedEquals(sel))
    expect(is(3)).toBe(true)
    expect(is('3')).toBe(false)
    setSel(NaN)
    expect(is(NaN)).toBe(false)
  })

  it('a read after a write and before the flush sees the write', () => {
    const [sel, setSel] = createSignal(1)
    const is = createRoot(() => createKeyedEquals(sel))
    setSel(2)
    expect(is(2)).toBe(true)
    expect(is(1)).toBe(false)
  })

  it('a reader that changes key follows it', () => {
    const [sel, setSel] = createSignal(5)
    const [key, setKey] = createSignal(1)
    const is = createRoot(() => createKeyedEquals(sel))
    const seen = []
    createRoot(() => createEffect(() => { seen.push(is(key())) }))
    setKey(5); flushSync()
    setSel(1); flushSync()             // key 1 is no longer this reader's
    setSel(5); flushSync()
    expect(seen).toEqual([false, true, false, true])
  })

  it('a disposed reader is not woken', () => {
    const [sel, setSel] = createSignal(0)
    const { runs, dispose } = rows(3, sel)
    dispose()
    setSel(1); flushSync()
    expect(runs).toEqual([0, 0, 0])
  })
})

// ─── compiler ───────────────────────────────────────────────────────────────

async function compile(src) {
  const ctx = await compileSource(src, { filename: '/K.mesa', dev: false, loc: false })
  acorn.parse(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })   // Invariant 15
  return ctx.result
}

const table = (script, row, extra = '') => `<script>
  let rows = []
  ${script}
</script>
{#each rows as row (row.id)}
  ${row}
{/each}${extra}`

describe('the compiler lifts a keyed comparison out of a row', () => {
  it('either side order, and one selector per distinct outer read', async () => {
    const js = await compile(table('let selected = 0',
      '<tr class:a={selected === row.id} aria-selected={row.id === selected}>{row.label}</tr>'))
    expect(js.match(/createKeyedEquals/g)).toHaveLength(1)
    expect(js).toContain('$$sel1(row().id)')
    expect(js).not.toMatch(/get\(\$\$sig_selected\) ===|=== \$\$runtime\.get\(\$\$sig_selected\)/)
  })

  it('!== becomes a negation', async () => {
    const js = await compile(table('let selected = 0', '<tr class:dim={selected !== row.id}></tr>'))
    expect(js).toContain('(!$$sel1(row().id))')
  })

  it('a prop, a derived const and a member read off a let', async () => {
    const js = await compile(table(
      'export let active = 0\n  let sel = { id: 1 }\n  let n = 0\n  const cur = n + 1',
      '<tr class:a={active === row.id} class:b={sel?.id === row.id} class:c={cur === row.id}></tr>'))
    expect(js.match(/createKeyedEquals/g)).toHaveLength(3)
    expect(js).toContain('createKeyedEquals(() => $$runtime.get($$sig_sel)?.id)')
    expect(js).toContain('createKeyedEquals(() => $$runtime.get(cur))')
  })

  it('a destructured item and an index are row reads', async () => {
    const js = await compile(`<script>
  let rows = []
  let selected = 0
</script>
{#each rows as { id }, i (id)}
  <tr class:a={selected === id} class:b={selected === i}></tr>
{/each}`)
    expect(js.match(/\$\$sel1\(/g)).toHaveLength(2)
  })
})

describe('the compiler leaves alone what it cannot lift', () => {
  it('a derived name a row header declares again', async () => {
    const js = await compile(table('let n = 0\n  const cur = n + 1',
      '{@const cur = row.id}<tr class:a={cur === row.id}></tr>'))
    expect(js).not.toContain('createKeyedEquals')
  })

  it('a comparison that reads no row', async () => {
    const js = await compile(table('let a = 0\n  let b = 0', '<tr class:x={a === b}></tr>'))
    expect(js).not.toContain('createKeyedEquals')
  })

  it('an outer side that is more than a read', async () => {
    const js = await compile(table('let a = 0', '<tr class:x={a + 1 === row.id}></tr>'))
    expect(js).not.toContain('createKeyedEquals')
  })

  it('a function parameter that shadows the item', async () => {
    const js = await compile(table('let selected = 0',
      '<button onclick={() => rows.find((row) => selected === row.id)}>x</button>'))
    expect(js).not.toContain('createKeyedEquals')
  })

  it('== is not ===', async () => {
    const js = await compile(table('let selected = 0', '<tr class:a={selected == row.id}></tr>'))
    expect(js).not.toContain('createKeyedEquals')
  })

  it('outside any {#each}', async () => {
    const js = await compile(table('let selected = 0\n  let other = 1', '<i></i>',
      '\n<p class:a={selected === other}></p>'))
    expect(js).not.toContain('createKeyedEquals')
  })
})

describe('nested {#each}', () => {
  it('each comparison lifts to the block whose item it reads, and a sibling after an inner block still lifts', async () => {
    const js = await compile(`<script>
  let groups = []
  let selected = 0
</script>
{#each groups as g (g.id)}
  <h2 class:a={selected === g.id}></h2>
  {#each g.rows as row (row.id)}
    <tr class:b={selected === row.id}></tr>
  {/each}
  <p class:c={selected === g.id}></p>
{/each}`)
    const decl = js.match(/const (\$\$sel\d+) = \$\$runtime\.createKeyedEquals/g)
    expect(decl).toHaveLength(2)
    expect(js).toMatch(/\$\$sel\d+\(g\(\)\.id\).*'a'/)
    expect(js).toMatch(/\$\$sel\d+\(row\(\)\.id\).*'b'/)
    expect(js).toMatch(/\$\$sel\d+\(g\(\)\.id\).*'c'/)
  })
})

it('the same source compiles to the same output twice (Invariant 12)', async () => {
  const src = table('let selected = 0', '<tr class:a={selected === row.id}></tr>')
  await compile(table('let x = 0', '<tr class:a={x === row.id}></tr>'))
  const a = await compile(src)
  await compile(src)
  expect(await compile(src)).toBe(a)
})

// ─── compiled, mounted ──────────────────────────────────────────────────────

let n = 0

// Mounts `src` against a runtime whose createKeyedEquals counts every read, and
// returns the page with a way to click the i-th row's link.
async function mountCounting(src) {
  const ctx = await compileSource(src, { filename: `/KM${n}.mesa`, dev: false })
  const rt = path.join(process.cwd(), `_tmp_keyed_rt_${n}.mjs`)
  writeFileSync(rt, `export * from './src/runtime.js'
import { createKeyedEquals as k } from './src/runtime.js'
export const createKeyedEquals = (s) => { const is = k(s); return (key) => { globalThis.__keyedReads++; return is(key) } }
`)
  const file = path.join(process.cwd(), `_tmp_keyed_${n}.mjs`)
  writeFileSync(file, ctx.result.replace(/'@frontierjs\/mesa\/runtime(\.js)?'/g, `'./${path.basename(rt)}'`))
  n++
  let Comp
  try { Comp = (await import('file://' + file)).default }
  finally { for (const f of [file, rt]) try { unlinkSync(f) } catch {} }

  const wrap = document.createElement('div')
  document.body.appendChild(wrap)
  const anchor = document.createElement('span')
  wrap.appendChild(anchor)
  globalThis.__keyedReads = 0
  mount(anchor, Comp, { props: {} })
  flushSync()
  return {
    wrap,
    reads: () => globalThis.__keyedReads,
    pick(i) { globalThis.__keyedReads = 0; wrap.querySelectorAll('a')[i].click(); flushSync() },
    danger: () => [...wrap.querySelectorAll('tr.danger')].map((tr) => tr.textContent),
  }
}

describe('a mounted table wakes two rows on a select', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('the compiled comparison reads the selector for two rows, and the classes are right', async () => {
    const page = await mountCounting(`<script>
  let rows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }))
  let selected = 0
</script>
<table><tbody>
{#each rows as row (row.id)}
  <tr class:danger={selected === row.id}><td><a onclick={() => selected = row.id}>{row.id}</a></td></tr>
{/each}
</tbody></table>`)
    expect(page.reads()).toBe(50)
    page.pick(9)
    expect(page.reads()).toBe(1)          // nothing was selected, so one row moves
    expect(page.danger()).toEqual(['10'])
    page.pick(29)
    expect(page.reads()).toBe(2)
    expect(page.danger()).toEqual(['30'])
  })

  // docs/VISION.md § 9.2 — the hand-written form, behind a helper the compiler
  // cannot see into.
  it('the VISION example: a selector called from a helper', async () => {
    const page = await mountCounting(`<script>
  import { createKeyedEquals } from '@frontierjs/mesa/runtime'
  let rows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, done: i % 2 === 0 }))
  let selected = 0
  const isSelected = createKeyedEquals(() => selected)
  const rowClass = (row) => isSelected(row.id) ? 'danger' : row.done ? 'muted' : ''
</script>
<table><tbody>
{#each rows as row (row.id)}
  <tr class={rowClass(row)}><td><a onclick={() => selected = row.id}>{row.id}</a></td></tr>
{/each}
</tbody></table>`)
    expect(page.reads()).toBe(50)
    page.pick(4)
    expect(page.reads()).toBe(1)
    page.pick(7)
    expect(page.reads()).toBe(2)
    expect(page.danger()).toEqual(['8'])
    expect(page.wrap.querySelectorAll('tr.muted')).toHaveLength(25)
  })
})
