/*
 * dnd-configure.mjs
 * `FJS-2494` -- dndzone re-ran `configure` on every change to `items` and wrote
 * draggable and three styles on every child whether or not they differed, so a
 * rename in one row was n attribute mutations. A write of the value already
 * there still queues a MutationObserver record.
 *
 * Run: node test/dnd-configure.mjs
 */
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const require = createRequire(new URL('../../mesa/package.json', import.meta.url))
const { Window } = require('happy-dom')
const win = new Window()
for (const k of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'CustomEvent', 'Event'])
  globalThis[k] ??= k === 'window' ? win : win[k]
globalThis.window = win
globalThis.document = win.document

const { dndzone } = await import('../dnd.js')
const { createSignal, flushSync } = await import('../../mesa/src/runtime.js')

const ul = document.createElement('ul')
document.body.appendChild(ul)
for (const id of [1, 2, 3]) {
  const li = document.createElement('li')
  li.textContent = String(id)
  ul.appendChild(li)
}

const [items, setItems] = createSignal([{ id: 1 }, { id: 2 }, { id: 3 }])
dndzone(() => ({ items: items() }))(ul)
flushSync()
assert.equal(ul.children[0].style.cursor, 'grab', 'the first configure styles the rows')

const seen = []
const mo = new MutationObserver((recs) => { for (const r of recs) seen.push(`${r.target.nodeName}:${r.attributeName}`) })
mo.observe(ul, { subtree: true, attributes: true })
setItems([{ id: 1 }, { id: 2, renamed: true }, { id: 3 }])
flushSync()
seen.push(...mo.takeRecords().map((r) => `${r.target.nodeName}:${r.attributeName}`))
mo.disconnect()

assert.deepEqual(seen, [], 'a changed item list with the same rows writes nothing to them')
console.log('dnd-configure: ok')
process.exit(0)
