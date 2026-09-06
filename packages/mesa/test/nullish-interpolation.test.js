/**
 * nullish-interpolation.test.js — `{maybe}` renders nothing (FJS-854, FJS-D208).
 *
 * `set_text` opens with a nullish-to-empty-string guard that no template can
 * reach: the compiler wraps every interpolation in a template literal, so the
 * coercion has already happened in the emitted module and the runtime is handed
 * the seven characters `undefined`. Both renderers agree, so there is no
 * hydration mismatch to catch it — which is why the client and the server are
 * asked the same question here.
 *
 * The rule is narrow on purpose. RULE 12's optional-chaining rewrite was
 * withdrawn: a deep path through an absent object still throws, because a
 * misspelling and a genuinely absent value must not look the same. What is kept
 * is that a nullish VALUE paints nothing.
 *
 * The server half runs LAST and in a describe of its own. `initRenderer()`
 * overwrites `document` with its own happy-dom window and `resetRenderer()`
 * deletes it, so a client mount after either one has no DOM at all.
 *
 * Run: npx vitest run nullish-interpolation.test.js
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { compile, compileSource } from '../src/compiler.js'
import { initRenderer, renderToHTML } from '../src/render.js'
import * as runtime from '../src/runtime.js'
import * as acorn from 'acorn'

const cx = (src) => compile(src, { debug: false, css: false }).then((c) => c.result)

let n = 0

/** Compile and import as a build tool would, so both renderers run one module. */
async function build(src) {
  const ctx = await compileSource(src, { filename: `/N${n}.mesa`, dev: false })
  if (ctx.analysis?.errors?.length) throw new Error(ctx.analysis.errors[0])
  const js = ctx.result.replace(/'@frontierjs\/mesa\/runtime\.js'/g, `'./src/runtime.js'`)
  const file = path.join(process.cwd(), `_tmp_nullish_${n++}.mjs`)
  writeFileSync(file, js)
  try { return (await import('file://' + file)).default }
  finally { try { unlinkSync(file) } catch {} }
}

/** Mount into a detached container and read the text back. */
function clientText(Comp, props = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const anchor = document.createComment('')
  container.appendChild(anchor)
  runtime.flushSync()
  Comp(anchor, props, null)
  runtime.flushSync()
  const text = container.textContent
  container.remove()
  return text
}

// The components both halves render. Built once so the two renderers are
// handed the same module, which is what makes the comparison an oracle rather
// than two compilations agreeing about themselves.
const C = {}
const CASES = {
  absent: `<script>export let u = {}</script><p>[{u.middleName}]</p>`,
  nul: `<script>export let v = null</script><p>[{v}]</p>`,
  falsy: `<script>export let a = 0, b = false, c = NaN</script><p>{a}|{b}|{c}</p>`,
  deep: `<script>export let o = {}</script><p>{o.a.b}</p>`
}
const PROPS = {
  absent: { u: {} },
  nul: { v: null },
  falsy: { a: 0, b: false, c: NaN },
  deep: { o: {} }
}

beforeAll(async () => {
  for (const k in CASES) C[k] = await build(CASES[k])
})

// ── emission ─────────────────────────────────────────────────────────────────

describe('a nullish interpolation is coerced in the emitted module', () => {
  it('guards a lone interpolation', async () => {
    const out = await cx(`<script>let a = 1</script><p>{a}</p>`)
    expect(out).toContain(`\${($$runtime.get($$sig_a)) ?? ''}`)
  })

  it('guards each hole of a mixed text node, not the literal around them', async () => {
    const out = await cx(`<script>let a = 1, b = 2</script><p>hi {a} and {b}!</p>`)
    expect(out).toContain(
      `\`hi \${($$runtime.get($$sig_a)) ?? ''} and \${($$runtime.get($$sig_b)) ?? ''}!\``
    )
  })

  it("parenthesises the operand — `${a || b ?? ''}` is a SyntaxError", async () => {
    const out = await cx(`<script>let a = null, b = 'x'</script><p>{a || b}</p>`)
    expect(out).toContain(`($$runtime.get($$sig_a) || $$runtime.get($$sig_b)) ?? ''`)
    expect(() => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()
  })

  it('leaves an ATTRIBUTE alone — null there means remove the attribute', async () => {
    const out = await cx(`<script>let t = null</script><p title="{t}"></p>`)
    expect(out).not.toContain(`?? ''`)
  })
})

// ── the client ───────────────────────────────────────────────────────────────

describe('what a nullish value paints in the browser', () => {
  it('undefined renders empty', () => {
    expect(clientText(C.absent, PROPS.absent)).toBe('[]')
  })

  it('null renders empty', () => {
    expect(clientText(C.nul, PROPS.nul)).toBe('[]')
  })

  it('0, false and NaN are values and still print', () => {
    expect(clientText(C.falsy, PROPS.falsy)).toBe('0|false|NaN')
  })

  it('a value arriving later still replaces the empty text', () => {
    expect(clientText(C.nul, { v: undefined })).toBe('[]')
    expect(clientText(C.nul, { v: 'here' })).toBe('[here]')
  })

  it('a deep path through an absent object still throws — RULE 12 stays withdrawn', () => {
    expect(() => clientText(C.deep, PROPS.deep)).toThrow()
  })
})

// ── the server, which must agree ─────────────────────────────────────────────

describe('and the same on the server', () => {
  beforeAll(() => { initRenderer() })

  it('undefined renders empty', async () => {
    expect(await renderToHTML(C.absent, PROPS.absent)).toContain('[]')
  })

  it('null renders empty', async () => {
    expect(await renderToHTML(C.nul, PROPS.nul)).toContain('[]')
  })

  it('0, false and NaN are values and still print', async () => {
    expect(await renderToHTML(C.falsy, PROPS.falsy)).toContain('0|false|NaN')
  })
})
