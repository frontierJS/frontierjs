/*
 * selection.mjs
 * `createSelection` (FJS-D671), the set a screen that multi-selects composes.
 *
 * What each verb does over the rows it is GIVEN is the contract, because the
 * rows given are the visible page or one group: a header box judges only
 * those, and a key whose row left the screen stays held. The reactivity half
 * (a template re-rendering on a toggle) is the browser drive's
 * `selection.spec.mjs`; here it is that a read subscribes and a no-op writes
 * nothing.
 *
 * Run: node test/selection.mjs
 */
import assert from 'node:assert/strict'

const { createSelection } = await import('../selection.js')
const { createEffect, flushSync } = await import('../../mesa/src/runtime.js')

const results = []
function check(label, fn) {
  try { fn(); results.push([label, null]) } catch (e) { results.push([label, e]) }
}

const msg  = (id) => ({ kind: 'message', id })
const task = (id) => ({ kind: 'task', id })

check('toggle ticks and unticks one row, by row.id when no keyOf is given', () => {
  const s = createSelection()
  const a = { id: 1 }
  assert.equal(s.has(a), false)
  s.toggle(a)
  assert.equal(s.has(a), true)
  assert.equal(s.has({ id: 1 }), true, 'a different object with the same key is the same row')
  assert.equal(s.count, 1)
  s.toggle(a)
  assert.equal(s.has(a), false)
  assert.equal(s.count, 0)
})

check('keys are in the order ticked', () => {
  const s = createSelection()
  s.toggle({ id: 3 }); s.toggle({ id: 1 }); s.toggle({ id: 2 })
  assert.deepEqual(s.keys, [3, 1, 2])
  s.set([{ id: 9 }, { id: 1 }])
  assert.deepEqual(s.keys, [3, 1, 2, 9], 'set appends only what was missing, in row order')
})

check('set(rows) ticks those rows and set(rows, false) unticks them, leaving the rest', () => {
  const s = createSelection()
  s.toggle({ id: 5 })
  s.set([{ id: 1 }, { id: 2 }])
  assert.deepEqual(s.keys, [5, 1, 2])
  s.set([{ id: 1 }, { id: 2 }], false)
  assert.deepEqual(s.keys, [5], 'a row outside the rows given keeps its tick')
})

check('clear unticks everything', () => {
  const s = createSelection()
  s.set([{ id: 1 }, { id: 2 }])
  s.clear()
  assert.equal(s.count, 0)
  assert.deepEqual(s.keys, [])
})

check('stateOf answers none, some and all over the rows given only', () => {
  const s = createSelection()
  const a = [{ id: 1 }, { id: 2 }]
  const b = [{ id: 3 }, { id: 4 }]
  assert.equal(s.stateOf(a), 'none')
  assert.equal(s.stateOf([]), 'none', 'an empty group is none, never all')
  s.toggle(a[0])
  assert.equal(s.stateOf(a), 'some')
  assert.equal(s.stateOf(b), 'none', 'one group being part-ticked says nothing about another')
  s.toggle(a[1])
  assert.equal(s.stateOf(a), 'all')
  assert.equal(s.stateOf([...a, ...b]), 'some')
})

check('a select-all toggle is set(rows, state !== all)', () => {
  const s = createSelection()
  const page = [{ id: 1 }, { id: 2 }, { id: 3 }]
  const press = () => s.set(page, s.stateOf(page) !== 'all')
  s.toggle(page[1])
  press()
  assert.equal(s.stateOf(page), 'all', 'a part-ticked header ticks the rest')
  press()
  assert.equal(s.stateOf(page), 'none', 'a full header unticks the page')
})

check('a key whose row left the screen stays held until retain drops it', () => {
  const s = createSelection()
  const all = [{ id: 1 }, { id: 2 }, { id: 3 }]
  s.set(all)
  const shown = all.slice(0, 2)
  assert.equal(s.stateOf(shown), 'all')
  assert.equal(s.count, 3, 'a filtered-out row is still counted')
  s.retain(shown)
  assert.deepEqual(s.keys, [1, 2])
})

check('two kinds sharing an id are two keys under a keyOf that names the kind', () => {
  const s = createSelection((r) => r.kind + ':' + r.id)
  s.toggle(msg(7))
  assert.equal(s.has(msg(7)), true)
  assert.equal(s.has(task(7)), false, 'ticking message 7 does not tick ticket 7')
  s.toggle(task(7))
  assert.deepEqual(s.keys, ['message:7', 'task:7'])
  assert.equal(s.stateOf([msg(7), task(7), task(8)]), 'some')
  // The control: keyed by id alone, the two kinds collide.
  const flat = createSelection()
  flat.toggle(msg(7))
  assert.equal(flat.has(task(7)), true)
})

check('the verbs are closures, so rows.filter(s.has) works unbound', () => {
  const s = createSelection()
  const rows = [{ id: 1 }, { id: 2 }]
  s.toggle(rows[1])
  assert.deepEqual(rows.filter(s.has), [rows[1]])
})

check('a read subscribes, and a verb that changes nothing notifies nobody', () => {
  const s = createSelection()
  const rows = [{ id: 1 }, { id: 2 }]
  let runs = 0
  let seen = ''
  createEffect(() => { runs++; seen = s.stateOf(rows) + ':' + s.count })
  assert.equal(runs, 1)
  s.toggle(rows[0]); flushSync()
  assert.equal(seen, 'some:1')
  assert.equal(runs, 2)
  s.set([rows[0]]); flushSync()
  s.set([{ id: 9 }], false); flushSync()
  s.retain(rows); flushSync()
  assert.equal(runs, 2, 'ticking a ticked row, unticking an unticked one and retaining everything held write nothing')
  s.set(rows); flushSync()
  assert.equal(seen, 'all:2')
  s.clear(); flushSync()
  s.clear(); flushSync()
  assert.equal(runs, 4, 'a clear of an empty selection writes nothing')
})

const failed = results.filter(([, e]) => e)
for (const [label, e] of results) console.log(`${e ? '✗' : '✓'} ${label}${e ? '\n    ' + e.message : ''}`)
if (failed.length) {
  console.error(`✗ selection — ${failed.length} of ${results.length} failed`)
  process.exit(1)
}
console.log(`✓ selection — ${results.length} checks`)
