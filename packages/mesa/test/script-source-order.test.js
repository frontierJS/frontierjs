/**
 * An instance `<script>` runs in the order it is written (`FJS-846`).
 *
 * It did not. The emitter put every declaration first, topologically sorted,
 * and everything else after — so a statement the author wrote ABOVE a
 * declaration ran below it. Six shapes were measured against what plain
 * JavaScript answers and five of the six disagreed; the one that agreed did so
 * by accident, because a reactive `const` compiles to a lazy memo and re-derives
 * on read whatever order it was declared in.
 *
 * Every case here is graded against the plain-JS answer rather than against a
 * remembered output, because that is the only oracle the question has: the
 * author wrote JavaScript and expects JavaScript's answer.
 *
 * Svelte is the useful comparison. Svelte 4 hoisted literal `const`s and pure
 * functions out of the instance body entirely (`hoist_instance_declarations`)
 * and it cost them #2687, #1895 and #2542. Svelte 5's sync mode preserves
 * source order exactly. The direction here is the one they moved toward.
 *
 * What is NOT source order, deliberately: a declaration is still pulled UP when
 * something emitted before it needs it — a class used by a `const` above it, a
 * memo another memo reads. That is the topological sort, now applied where it
 * is required instead of to the whole script.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { compileSource } from '../src/compiler.js'
import { mount, flushSync } from '../src/runtime.js'

const DIR = process.cwd()
let n = 0

/** Compile, mount, and answer what the component rendered. */
async function render(script, template = '') {
  const file = path.join(DIR, `_order_${n++}.mjs`)
  const src = `<script>\n${script}\n</script>${template}`
  const out = (await compileSource(src, { filename: 'T.mesa', css: false, dev: false })).result
  writeFileSync(file, out.replace(/'@frontierjs\/mesa\/runtime\.js'/g,
    `'${path.join(DIR, 'src/runtime.js')}'`))
  try {
    const C = (await import('file://' + file)).default
    const host = document.createElement('div')
    document.body.appendChild(host)
    const anchor = document.createElement('span')
    host.appendChild(anchor)
    mount(anchor, C, { props: {} })
    flushSync()
    return host.textContent.trim()
  } finally { try { unlinkSync(file) } catch {} }
}

beforeEach(() => { document.body.innerHTML = '' })

describe('a statement written above a declaration runs above it', () => {
  // Each case names the answer plain JavaScript gives for the same statements.
  const CASES = {
    'a reactive let reading an assigned value': [
      `let a = 0\na = 5\nlet b = a`, `{b}`, '5'],
    'a var sampler reading an assigned value': [
      `let a = 0\na = 5\nvar b = a`, `{b}`, '5'],
    'a const over a NON-reactive binding': [
      `var a = 0\na = 5\nconst b = a + 0`, `{b}`, '5'],
    'a let reading a mutated array': [
      `let xs = []\nxs.push(1)\nlet n = xs.length`, `{n}`, '1'],
    'a var reading what a call wrote': [
      `let o = { v: 0 }\nfunction f(){ o.v = 9 }\nf()\nvar s = o.v`, `{s}`, '9'],
    'two statements straddling a declaration': [
      `let g = []\ng.push('A')\nconst x = 1\ng.push('B')\nvar order = g.join('')`, `{order}{x}`, 'AB1'],
  }
  for (const [what, [script, tpl, want]] of Object.entries(CASES)) {
    it(`${what} — plain JS says ${want}`, async () => {
      expect(await render(script, tpl)).toBe(want)
    })
  }

  it('a reactive const was already right, and by accident', async () => {
    // A `const` over a reactive `let` is a lazy memo: it re-derives when read,
    // so it answered correctly no matter where it was emitted. It is here as
    // the control — the one case that must not change.
    expect(await render(`let a = 0\na = 5\nconst b = a`, `{b}`)).toBe('5')
  })
})

describe('what is still hoisted, because something needs it', () => {
  it('a class used by a const written above it', async () => {
    expect(await render(
      `const c = new Counter()\nclass Counter { constructor(){ this.n = 7 } }`, `{c.n}`)).toBe('7')
  })

  it('a memo another memo reads, written below it', async () => {
    expect(await render(
      `let a = 2\nconst doubled = base * 2\nconst base = a + 1`, `{doubled}`)).toBe('6')
  })

  it('a function declaration, which JavaScript hoists on its own', async () => {
    expect(await render(`const v = f()\nfunction f(){ return 7 }`, `{v}`)).toBe('7')
  })
})

describe('the emitted order itself', () => {
  it('puts the statement before the declaration in the source text', async () => {
    // Asserted on the emitted JS as well as on the rendered answer: the two can
    // agree for different reasons, and a memo's laziness hides the order.
    const out = (await compileSource(
      `<script>\nlet g = []\ng.push('A')\nconst x = 1\n</script><p>{g.length}{x}</p>`,
      { filename: 'T.mesa', css: false, dev: false })).result
    const body = out.slice(out.indexOf('export default'))
    expect(body.indexOf(`push('A')`), 'the push comes first')
      .toBeLessThan(body.indexOf('const x = 1'))
  })
})
