/*
 * dnd-inbox.spec.mjs — the three gestures ELA's inbox needs (FJS-D1024).
 *
 * A drop onto the middle of a ticket is a merge: no list changes and the
 * finalize names that ticket. A drop between tickets lands the record the
 * zone's `accept` built, which the host already rendered in the placeholder.
 * A selection drags as one stack, and Escape puts every member back where it
 * was rather than side by side. What is asserted is what the host holds.
 *
 * The pointer is left held between moves and each target point is read after
 * the move before it: entering the ticket list inserts a placeholder that
 * shifts the rows, so a point read before the drag is over another row.
 */
export const name = 'dndzone — drop onto an item, a foreign item that lands as another, a stack'
export const covers = []

const state = `document.getElementById('state').textContent`
const log   = `document.getElementById('log').textContent`
const onto  = `[...document.querySelectorAll('[data-dnd-onto]')].map((el) => el.dataset.id).join(',')`

const centerOf = (sel, t) => t.evaluate(`
  const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
`)
/** The empty band under a list's last row: inside the zone, past every row. */
const under = (sel, t) => t.evaluate(`
  const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.bottom - 16 };
`)

export async function run(t) {
  await t.mount('dnd-inbox')
  t.is(await t.evaluate(`return ${state};`), '1,2,3,4|101,102', 'the lists start as the fixture wrote them')

  /* ── a selection drags as a stack, and Escape scatters it back ────────── */

  let at = await under('#tickets', t)
  await t.drag('#inbox li[data-id="1"]', at, { release: false })
  await t.eventually(`${state}.split('|')[0]`, '2,4', 'both picked messages left the inbox together')
  t.is(await t.evaluate(`return document.querySelector('[data-dnd-ghost]')?.dataset.dndCount ?? '';`), '2',
    'the ghost is a stack that says how many it carries')
  await t.press('Escape')
  await t.eventually(state, '1,2,3,4|101,102', 'Escape puts each one back at its own index')
  await t.drag(at, at, { steps: 1, press: false })
  t.match(await t.evaluate(`return ${log};`), /inbox:droppedOutsideOfAny::1\+3$/, 'and the finalize names both records')

  /* ── a drop onto a ticket is a merge ──────────────────────────────────── */

  await t.drag('#inbox li[data-id="2"]', at, { release: false })
  await t.eventually(`${state}.split('|')[1]`, `101,102,id:dnd-shadow-placeholder-0000`, 'the placeholder sits under the tickets')
  t.is(await t.evaluate(`return document.querySelector('#tickets [data-dnd-shadow]')?.textContent.trim();`), 'from m2',
    'and it is the ticket accept built, not the message')
  let next = await centerOf('#tickets li[data-id="101"]', t)
  await t.drag(at, next, { steps: 4, press: false, release: false })
  at = next
  await t.eventually(onto, '101', 'the middle of a ticket marks it as the drop')
  next = await centerOf('#tickets li[data-id="102"]', t)
  await t.drag(at, next, { steps: 4, press: false, release: false })
  at = next
  await t.eventually(onto, '', 'a ticket dropOnto refuses is never marked')
  next = await centerOf('#tickets li[data-id="101"]', t)
  await t.drag(at, next, { steps: 4, press: false, release: false })
  at = next
  await t.eventually(onto, '101', 'back over the first ticket marks it again')
  await t.drag(at, at, { steps: 1, press: false })
  await t.eventually(state, '1,2,3,4|101,102', 'a merge moves nothing in either list')
  const merged = await t.evaluate(`return ${log};`)
  t.match(merged, /tickets:droppedOntoItem:101:2/, 'the ticket list finalizes with the ticket it landed on')
  t.match(merged, /inbox:droppedIntoAnother:101:2$/, 'and the inbox finalizes as the list it left')
  t.is(await t.evaluate(`return ${onto};`), '', 'no row is left marked')

  /* ── a drop between tickets lands the record accept built ─────────────── */

  at = await under('#tickets', t)
  await t.drag('#inbox li[data-id="2"]', at)
  await t.eventually(state, '1,3,4|101,102,new-2', 'the message landed as a new ticket')
  t.match(await t.evaluate(`return ${log};`), /tickets:droppedIntoZone::2 inbox:droppedIntoAnother::2$/, 'both lists finalized')

  /* ── a stack lands whole, in the inbox's order ────────────────────────── */

  at = await under('#tickets', t)
  await t.drag('#inbox li[data-id="3"]', at)
  await t.eventually(state, '4|101,102,new-2,new-1,new-3', 'both picked messages landed as tickets, in order')
  t.match(await t.evaluate(`return ${log};`), /tickets:droppedIntoZone::1\+3 inbox:droppedIntoAnother::1\+3$/, 'and the finalize carries both')
  t.is(await t.evaluate(`return document.querySelectorAll('[data-dnd-ghost], [data-dnd-target], [data-dnd-shadow]').length;`), 0,
    'nothing is left behind')

  /* ── the keyboard stops on a ticket it may drop onto (FJS-4459) ───────── */

  const ph   = 'id:dnd-shadow-placeholder-0000'
  const live = `(document.querySelector('[data-dnd-live]') || {}).textContent || ''`
  await t.evaluate(`document.querySelector('#inbox li[data-id="4"]').focus(); return true;`)
  await t.press(' ')
  await t.press('ArrowRight')
  await t.eventually(state, `|${ph},101,102,new-2,new-1,new-3`, 'the lifted message hops to the top of the tickets')
  await t.press('ArrowDown')
  await t.eventually(onto, '101', 'the arrow along the axis stops on the ticket first')
  t.is(await t.evaluate(`return ${state};`), `|${ph},101,102,new-2,new-1,new-3`, 'and the placeholder stays put')
  t.match(await t.evaluate(`return ${live};`), /T1/, 'and says which ticket it is on')
  await t.press('ArrowDown')
  await t.eventually(state, `|101,${ph},102,new-2,new-1,new-3`, 'the next arrow leaves the ticket for the slot past it')
  t.is(await t.evaluate(`return ${onto};`), '', 'and unmarks it')
  await t.press('ArrowDown')
  await t.eventually(state, `|101,102,${ph},new-2,new-1,new-3`, 'a ticket dropOnto refuses is stepped over')
  t.is(await t.evaluate(`return ${onto};`), '', 'and never marked')
  await t.press('ArrowUp')
  await t.eventually(state, `|101,${ph},102,new-2,new-1,new-3`, 'back over the refused ticket in one step')
  await t.press('ArrowUp')
  await t.eventually(onto, '101', 'and onto the first ticket from below')
  await t.press(' ')
  await t.eventually(state, '4|101,102,new-2,new-1,new-3', 'Space on a ticket merges and moves nothing')
  t.match(await t.evaluate(`return ${log};`), /tickets:droppedOntoItem:101:4 inbox:droppedIntoAnother:101:4$/,
    'and finalizes with the ticket it landed on')
  t.match(await t.evaluate(`return ${live};`), /onto T1/, 'and the drop says what it went onto')
  t.is(await t.evaluate(`return ${onto};`), '', 'no row is left marked')
}
