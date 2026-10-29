// cases.mjs — mesa's REPORTED tier in one process: the compiler, a server
// render and the signal graph, each timed beside a floor of hand-written code.
// `bun bench/cases.mjs` runs one round; scripts/bench-round.mjs is the loop.
//
// The browser half — DOM operations against a vanilla table — is `run.mjs`,
// and stays there: a Chrome round is ~10 s, and an A/B of it waits on its own
// trigger (IDEAS/performance-regression-watch.md § Mesa's slice). These are
// the costs that bench never times, and none needs a browser.
//
// A compiler has no "same work with nothing in between", so its floor is
// acorn parsing the component's own script — work the compile also does, on
// input that does not change when the compiler does.
//
// The base ref runs THIS file, not its own (scripts/bench-ab.mjs), so an edit
// here that needs a new runtime export reads as the base failing, and the
// runner says so rather than comparing nothing.

import { readFileSync }    from 'node:fs'
import { parse }           from 'acorn'
import { compile }         from '../src/compiler.js'
import { renderComponent } from '../src/render-component.js'
import { createRoot, createSignal, createMemo, createEffect, flushSync } from '../src/runtime.js'
import { buildData }       from './fixtures/shared/data.js'
import { main }            from '../../../scripts/bench-round.mjs'

const ROWS_SRC = readFileSync(new URL('./fixtures/rows/App.mesa', import.meta.url), 'utf8')
const SCRIPT   = ROWS_SRC.match(/<script>([\s\S]*?)<\/script>/)[1]

const TABLE = `<script>export let rows = []</script>
<table><tbody>
  {#each rows as row (row.id)}
    <tr data-id={row.id}><td>{row.id}</td><td><a>{row.label}</a></td></tr>
  {/each}
</tbody></table>`

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c])

// One write fans out to every effect through a chain of derivations — the
// shape a component's `$:` blocks make of one piece of state.
const EFFECTS = 10
const WRITES  = 100

export const cases = [
  {
    name: 'compile-rows', ceiling: 30, ops: 30,
    async open() {
      // A compile that stopped emitting would time faster, so its output is
      // parsed once first (Invariant 15).
      const { result } = await compile(ROWS_SRC, { filename: 'App.mesa', warning: () => {} })
      parse(result, { ecmaVersion: 'latest', sourceType: 'module' })
      return {}
    },
    run:   () => compile(ROWS_SRC, { filename: 'App.mesa', warning: () => {} }),
    floor: () => parse(SCRIPT, { ecmaVersion: 'latest', sourceType: 'module' }),
  },
  {
    name: 'ssr-100', ceiling: 250, ops: 30,
    async open() {
      const rows = buildData(100)
      const opts = { data: { rows }, cwd: '/tmp/mesa-bench', target: 'fragment' }
      // The first render builds and caches the module; the case times renders.
      const { html } = await renderComponent(TABLE, opts)
      if (!html.includes(esc(rows[99].label))) throw new Error('ssr-100: the render is missing the last row')
      return { rows, opts }
    },
    run:   ({ opts }) => renderComponent(TABLE, opts),
    floor: ({ rows }) => '<table><tbody>' + rows.map(r =>
      `<tr data-id="${r.id}"><td>${r.id}</td><td><a>${esc(r.label)}</a></td></tr>`).join('') + '</tbody></table>',
  },
  {
    // The same table through the string mode (`FJS-D1634`). The floor is the
    // same string, so the two ratios say what happy-dom costs.
    name: 'ssr-100-server', ceiling: 10, ops: 30,
    async open() {
      const rows = buildData(100)
      const opts = { data: { rows }, cwd: '/tmp/mesa-bench', target: 'fragment', compileOptions: { target: 'server' } }
      const { html, unlowered } = await renderComponent(TABLE, opts)
      if (unlowered.length) throw new Error('ssr-100-server: fell back to the DOM path — ' + unlowered[0].refused)
      if (!html.includes(esc(rows[99].label))) throw new Error('ssr-100-server: the render is missing the last row')
      return { rows, opts }
    },
    run:   ({ opts }) => renderComponent(TABLE, opts),
    floor: ({ rows }) => '<table><tbody>' + rows.map(r =>
      `<tr data-id="${r.id}"><td>${r.id}</td><td><a>${esc(r.label)}</a></td></tr>`).join('') + '</tbody></table>',
  },
  {
    name: 'signal-fanout', ceiling: 250, ops: 500,
    open() {
      const s = { sink: 0, runs: 0, plain: { a: 0, sinks: new Array(EFFECTS).fill(0) } }
      s.dispose = createRoot(dispose => {
        const [a, setA] = createSignal(0)
        const b = createMemo(() => a() * 2)
        const c = createMemo(() => b() + 1)
        for (let k = 0; k < EFFECTS; k++) createEffect(() => { s.runs++; s.sink += c() + k })
        s.setA = setA
        return dispose
      })
      flushSync()
      // Effects that stopped firing would time faster; every write must reach all of them.
      const before = s.runs
      s.close = () => {
        s.dispose?.()
        if (s.runs - before < EFFECTS * WRITES) throw new Error(`signal-fanout: ${s.runs - before} effect runs, fewer than one op's ${EFFECTS * WRITES}`)
      }
      return s
    },
    run(s, i) {
      for (let w = 1; w <= WRITES; w++) { s.setA(i * WRITES + w); flushSync() }
    },
    floor({ plain }, i) {
      for (let w = 1; w <= WRITES; w++) {
        plain.a = i * WRITES + w
        const c = plain.a * 2 + 1
        for (let k = 0; k < EFFECTS; k++) plain.sinks[k] += c + k
      }
    },
  },
]

if (import.meta.main) await main(cases)
