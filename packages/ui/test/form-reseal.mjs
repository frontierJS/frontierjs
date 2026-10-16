/*
 * form-reseal.mjs
 * `FJS-2745` -- <Form> read its seal off the row it opened and re-opened only
 * on a new id, so a move made on the screen that shows the row (Reject) stored
 * a sealing state under the SAME id and the newly sealed columns stayed live
 * boxes.
 *
 * The prop push is the thing under test, so this mounts the kit's own
 * `form-sealed` fixture in happy-dom rather than server-rendering it. Chrome is
 * the drive's (`test/browser/specs/form-sealed.spec.mjs` asserts the same); this
 * is the half that runs anywhere. Bun is the runner because loading a `.mesa`
 * graph needs a resolver hook, and bun's is a few lines.
 *
 * Run: bun test/form-reseal.mjs
 */
import { plugin } from 'bun'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const UI     = fileURLToPath(new URL('..', import.meta.url))
const MESA   = fileURLToPath(new URL('../../mesa', import.meta.url))
const SIERRA = fileURLToPath(new URL('../../sierra', import.meta.url))

const { Window } = createRequire(MESA + '/package.json')('happy-dom')
const win = new Window()
for (const k of ['HTMLElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle',
  'requestAnimationFrame', 'ShadowRoot', 'CustomEvent', 'Event', 'HTMLInputElement', 'DocumentFragment'])
  globalThis[k] = win[k]
globalThis.window = win
globalThis.document = win.document

const { compileSource } = await import(MESA + '/src/compiler.js')
const FIELD_RULES = SIERRA + '/src/resource/field-rules.js'

// Mesa and the kit are read by path, never through their package names: an
// install copy of either would be a snapshot of code this test is not about.
plugin({
  name: 'mesa',
  setup(b) {
    b.onResolve({ filter: /^@frontierjs\/mesa\/runtime(\.js)?$/ }, () => ({ path: MESA + '/src/runtime.js' }))
    b.onResolve({ filter: /^@frontierjs\/ui\// }, (a) => ({
      path: UI + a.path.slice('@frontierjs/ui/'.length) + (/\.\w+$/.test(a.path) ? '' : '.js'),
    }))
    b.onLoad({ filter: /\.mesa$/ }, async ({ path }) => {
      const ctx = await compileSource(readFileSync(path, 'utf8'), { filename: path, dev: false, css: false })
      // bun resolves a subpath that is not an `exports` entry before any plugin sees it.
      return {
        contents: ctx.result.replaceAll("'@frontierjs/sierra/field-rules'", JSON.stringify(FIELD_RULES)),
        loader: 'js',
      }
    })
  },
})

const runtime = await import(MESA + '/src/runtime.js')
const Fixture = (await import(UI + 'test/browser/fixtures/form-sealed.mesa')).default

const tick = () => new Promise((r) => setTimeout(r, 10))
const host = document.createElement('div')
document.body.appendChild(host)
const anchor = document.createElement('span')
host.appendChild(anchor)
runtime.mount(anchor, Fixture, { props: {} })
await tick()

const frozen = (sel) => !!document.querySelector(sel)?.disabled

async function pick(sel, value) {
  const el = document.querySelector(sel)
  el.value = value
  el.dispatchEvent(new window.Event('change', { bubbles: true }))
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
  await tick()
}

// The pair: a draft opens editable, the row pushed again as issued freezes the
// column, and the column beside it stays writable.
assert.equal(frozen('#moved [name=number]'), false, 'a draft opens with its column editable')
window.kitMove()
await tick()
assert.equal(frozen('#moved [name=number]'), true, 'the same id pushed again as issued freezes the column')
assert.equal(frozen('#moved [name=note]'), false, 'and leaves the ordinary column alone')

// What must NOT reopen: picking the sealing state is a draft, bound or not.
await pick('#bound [name=state]', 'issued')
assert.equal(frozen('#bound [name=number]'), false, 'choosing the sealing state freezes nothing, though the parent holds the draft')
window.kitMoveBound()
await tick()
assert.equal(frozen('#bound [name=number]'), true, 'a bound parent re-reading the row as issued freezes it')

console.log('form-reseal: ok')
