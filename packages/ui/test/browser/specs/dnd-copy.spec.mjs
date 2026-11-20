/*
 * dnd-copy.spec.mjs — a palette roster copies and never moves (FJS-D1166).
 *
 * The roster writes back every list it is handed, so the chip leaving it for
 * the length of a drag (`FJS-2818`) shows in `#state` and in a hidden row.
 * Asserted for the drag over the shift, with the pointer outside every zone,
 * a drop back into the roster (a cancel), and a keyboard lift that hops over.
 *
 * The pointer is left held between moves and each point is read after the
 * move before it: the shift's placeholder shifts what is under it.
 */
export const name = 'dndzone — copy: a palette keeps its item for the whole drag'
export const covers = []

const state  = `document.getElementById('state').textContent`
const log    = `document.getElementById('log').textContent`
const shown  = `[...document.querySelectorAll('#roster li')].filter((el) => el.style.visibility !== 'hidden' && !el.hasAttribute('data-dnd-shadow')).map((el) => el.dataset.id).join(',')`
const marked = `document.getElementById('roster').hasAttribute('data-dnd-target')`

const centerOf = (sel, t) => t.evaluate(`
  const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
`)
/** The empty band under a list's last row: inside the zone, past every row. */
const under = (sel, t) => t.evaluate(`
  const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.bottom - 16 };
`)
/** Right of the shift, level with its first row: inside no zone. */
const outside = (t) => t.evaluate(`
  const r = document.getElementById('shift').getBoundingClientRect();
  return { x: r.right + 120, y: r.top + 20 };
`)

export async function run(t) {
  await t.mount('dnd-copy')
  t.is(await t.evaluate(`return ${state};`), 'p1,p2,p3|s1', 'the lists start as the fixture wrote them')

  /* ── mid-drag the roster keeps the chip, over a zone and over none ────── */

  let at = await under('#shift', t)
  await t.drag('#roster li[data-id="p2"]', at, { release: false })
  await t.eventually(`${state}.split('|')[1]`, 's1,id:dnd-shadow-placeholder-0000', 'the shift holds the placeholder')
  t.is(await t.evaluate(`return ${state};`).then((s) => s.split('|')[0]), 'p1,p2,p3', 'and the roster still holds the chip')
  t.is(await t.evaluate(`return ${shown};`), 'p1,p2,p3', 'with every row of it on screen')
  t.is(await t.evaluate(`return ${marked};`), false, 'the roster is not marked as a target')
  let next = await outside(t)
  await t.drag(at, next, { steps: 4, press: false, release: false })
  at = next
  await t.eventually(state, 'p1,p2,p3|s1', 'outside every zone the shift lets go of the placeholder')
  t.is(await t.evaluate(`return ${shown};`), 'p1,p2,p3', 'and the roster holds no hidden gap')

  /* ── a drop on the shift copies ───────────────────────────────────────── */

  next = await under('#shift', t)
  await t.drag(at, next, { steps: 4, press: false, release: false })
  at = next
  await t.eventually(`${state}.split('|')[1]`, 's1,id:dnd-shadow-placeholder-0000', 'back over the shift')
  await t.drag(at, at, { steps: 1, press: false })
  await t.eventually(state, 'p1,p2,p3|s1,a-p2', 'the chip is copied onto the shift and stays in the roster')
  t.match(await t.evaluate(`return ${log};`), /shift:droppedIntoZone:p2 roster:copiedIntoAnother:p2$/,
    'the roster finalizes as copied, with its own rows')
  t.ok(!/roster:(dragStarted|draggedLeft)/.test(await t.evaluate(`return ${log};`)), 'the roster was never handed a list without the chip')

  /* ── a drop back into the roster cancels ──────────────────────────────── */

  at = await centerOf('#roster li[data-id="p3"]', t)
  await t.drag('#roster li[data-id="p1"]', at)
  await t.eventually(`${log}.split(' ').pop()`, 'roster:droppedOutsideOfAny:p1', 'a drop into the roster finalizes as a cancel')
  t.is(await t.evaluate(`return ${state};`), 'p1,p2,p3|s1,a-p2', 'and moves nothing')

  /* ── the keyboard: the arrow along the roster stays, across hops ──────── */

  await t.evaluate(`document.querySelector('#roster li[data-id="p3"]').focus(); return true;`)
  await t.press(' ')
  await t.press('ArrowUp')
  t.is(await t.evaluate(`return ${state};`), 'p1,p2,p3|s1,a-p2', 'a lift and an arrow along the roster reorder nothing')
  await t.press('ArrowRight')
  await t.eventually(`${state}.split('|')[1]`, 's1,a-p2,id:dnd-shadow-placeholder-0000', 'the arrow across hops into the shift')
  t.is(await t.evaluate(`return ${state};`).then((s) => s.split('|')[0]), 'p1,p2,p3', 'and the roster keeps the chip')
  await t.press(' ')
  await t.eventually(state, 'p1,p2,p3|s1,a-p2,a-p3', 'Space drops a copy')
}
