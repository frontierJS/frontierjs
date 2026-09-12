/**
 * FJS-1070 — one expression, every binding position, one verdict.
 *
 * `const list = users.list()` is not promoted, and must not be: `FJS-D212`
 * keeps the initializer eager, and `EXTERNAL_REACTIVITY.md` is why a call to an
 * IMPORT is not a door reactivity comes through on its own. What the call hands
 * BACK is a different fact — it may hold getters over signals — and the four
 * places a template can read `list.sortKey` disagreed about it:
 *
 *   <Table sortKey={list.sortKey} />   live — a prop is pushed from an effect
 *   {#each list.rows() as r}           live — a thunk, re-invoked per pass
 *   <span data-s={list.sortKey}>       FROZEN
 *   {list.sortKey}                     FROZEN — emitted outside any effect
 *
 * A page over that controller is half live: the table moves and the sentence
 * beside it does not, which reads as a data bug and sends the reader to the
 * service. The downgrade that froze the last two guessed from emitted TEXT and
 * answered by the SHAPE of the read — a call on a bare local was reactive, the
 * identical value behind a member was not — which is why three of the four
 * rules above it in `_isReactive` are carve-outs for cases the guess got wrong.
 *
 * The claim is asserted as a PROPERTY over the positions rather than as four
 * expectations, so a position added to the language fails here if it wires only
 * some of them.
 *
 * Two negative controls carry it, and both are the narrowing rather than the
 * fix. A binding is reached THROUGH an opaque value or it is nothing: a bare
 * `{titleId}` over `const titleId = uniqueId()` names a const that cannot move,
 * and marking it put twelve kit components in a render block for nothing. And
 * the initializer's VALUE is what decides, not what appears inside it —
 * `const shown = (v) => JSON.stringify(v)` is a function this script wrote, and
 * a blanket walk marked it because its BODY holds a call.
 */

import { describe, it, expect } from 'vitest'
import { compile } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

function execCompiled(code, mock = {}) {
  const names = [], values = []
  for (const m of code.matchAll(/^import\s+\{([^}]+)\}\s+from\s+'[^']+';$/gm))
    m[1].split(',').forEach((spec) => {
      const [orig, alias] = spec.split(/\s+as\s+/)
      names.push((alias || orig).trim()); values.push(mock[orig.trim()])
    })
  code = code.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
    .replace(/^export default\s+/m, 'const __component = ')
  return new Function('$$runtime', ...names, code + '\nreturn __component')(runtime, ...values)
}

async function mount(src, mock) {
  const ctx = await compile(src, { debug: false, css: false })
  if (ctx.analysis.errors.length) throw new Error(ctx.analysis.errors[0])
  const Component = execCompiled(ctx.result, mock)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const anchor = document.createComment('')
  container.appendChild(anchor)
  runtime.createRoot(() => { Component(anchor, {}, null); runtime.registerComponentAnchor(anchor) })
  runtime.flushSync()
  return container
}

// A controller of the shape a plain module hands back: getters over a memo, and
// a method. Nothing here is declared to the compiler — that is the point.
function controller() {
  const [read, write] = runtime.createSignal('-')
  const api = {
    get sortKey() { return read() },
    rows: () => [{ n: read() }],
    move: (v) => { write(v); runtime.flushSync() },
  }
  return api
}

describe('a value that came out of a call reads the same in every position (FJS-1070)', () => {
  const POSITIONS = {
    'text':           '<p>{list.sortKey}</p>',
    'attribute':      '<span data-s={list.sortKey}>x</span>',
    'each thunk':     '{#each list.rows() as r}<i>{r.n}</i>{/each}',
    'method in text': '<b>{list.rows()[0].n}</b>',
  }

  for (const [what, markup] of Object.entries(POSITIONS)) {
    it(`${what} moves when the controller does`, async () => {
      const api = controller()
      const el = await mount(
        `<script>\n  import { users } from './r.js'\n  const list = users.list()\n</script>\n${markup}`,
        { users: { list: () => api } }
      )
      const before = el.textContent + '|' + (el.querySelector('[data-s]')?.getAttribute('data-s') ?? '')
      api.move('total')
      const after = el.textContent + '|' + (el.querySelector('[data-s]')?.getAttribute('data-s') ?? '')
      expect(before).not.toBe(after)
      expect(after).toContain('total')
    })
  }

  it('the destructured half is the same fact', async () => {
    const api = controller()
    const el = await mount(
      `<script>\n  import { users } from './r.js'\n  const { rows } = users.list()\n</script>\n<p>{rows()[0].n}</p>`,
      { users: { list: () => api } }
    )
    expect(el.textContent).toContain('-')
    api.move('total')
    expect(el.textContent).toContain('total')
  })
})

describe('what the narrowing leaves alone', () => {
  // A const bound to a call's result cannot itself move, so reading the NAME is
  // a one-time write. Twelve kit components are `const id = props.id ?? uniqueId()`.
  it('a bare read of the name stays a one-time write', async () => {
    const ctx = await compile(
      `<script>\n  import { uniqueId } from './u.js'\n  const titleId = uniqueId()\n</script>\n<h2 id={titleId}>t</h2>`,
      { debug: false, css: false }
    )
    const code = String(ctx.result)
    expect(code).toMatch(/set_attribute\([^,]+, 'id', titleId\)/)
    expect(code).not.toMatch(/render\(\(__prev\)[\s\S]*'id'/)
  })

  // The initializer's VALUE decides, not what appears inside it.
  it('a function this script wrote is not an opaque value', async () => {
    const ctx = await compile(
      `<script>\n  const shown = (v) => JSON.stringify(v)\n  const item = { a: 1 }\n</script>\n<p>{shown(item.a)}</p>`,
      { debug: false, css: false }
    )
    expect(ctx.analysis.opaqueValues).not.toContain('shown')
  })

  it('but the value a call handed back is one', async () => {
    const ctx = await compile(
      `<script>\n  import { useStore } from './j.js'\n  const { get: rows } = useStore('s')\n  const list = useStore('t').view\n  const plain = { a: 1 }\n</script>\n<p>{rows()}{list.x}{plain.a}</p>`,
      { debug: false, css: false }
    )
    expect(ctx.analysis.opaqueValues).toContain('rows')
    expect(ctx.analysis.opaqueValues).toContain('list')
    expect(ctx.analysis.opaqueValues).not.toContain('plain')
  })
})
