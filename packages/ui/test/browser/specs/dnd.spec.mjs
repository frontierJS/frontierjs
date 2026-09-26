/*
 * dnd.spec.mjs — dndzone, driven by a real pointer.
 *
 * Nothing but a browser can see any of this: the drag is pointer capture, a
 * frame loop and layout read once at the start, and the list it hands back is
 * written by the host between frames. What is asserted is what the HOST ends up
 * holding — `#state` is the three lists as the fixture's own variables have
 * them — plus the trigger each callback reported, since a drop that lands in
 * the right list with the wrong trigger is a save the app would skip.
 *
 * The drag helper waits a frame per step. Faster than that, the loop sees one
 * pointer position per frame and never crosses the slots between.
 */
export const name = 'dndzone — reorder, cross-list, refusal, cancel'
export const covers = []

const state = `document.getElementById('state').textContent`
const log   = `document.getElementById('log').textContent`
const reset = `document.getElementById('log').textContent`

/** A point just past the far edge of a list item, so the pointer sits below
 *  its midpoint and the insertion index is the slot AFTER it. */
const below = (sel, t) => t.evaluate(`
  const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.bottom - 2 };
`)

export async function run(t) {
  await t.mount('dnd')
  t.is(await t.evaluate(`return ${state};`), '1,2,3,4|5|9', 'the lists start as the fixture wrote them')

  /* ── a reorder within one list ────────────────────────────────────────── */

  await t.drag('#todo li[data-id="1"]', await below('#todo li[data-id="3"]', t))
  await t.eventually(state, '2,3,1,4|5|9', 'one dragged past three lands after it')
  t.match(await t.evaluate(`return ${log};`), /todo:c:dragStarted/, 'the drag announced itself with dragStarted')
  t.match(await t.evaluate(`return ${log};`), /todo:f:droppedIntoZone$/, 'and finalized once, into its own zone')
  t.is(await t.evaluate(`return document.querySelectorAll('[data-dnd-ghost]').length;`), 0,
    'the ghost is gone after the drop')
  t.is(await t.evaluate(`return document.querySelectorAll('[data-dnd-target], [data-dnd-shadow]').length;`), 0,
    'and no zone or item is left marked')
  // The placeholder is hidden with visibility, and a keyed each KEEPS the
  // element that stops being the placeholder — left marked, a real row would
  // stay invisible with nothing on screen to say why.
  t.is(await t.evaluate(`return [...document.querySelectorAll('#todo li')].filter(li => li.style.visibility === 'hidden').length;`), 0,
    'every row is visible again')

  /* ── across two lists of one type ─────────────────────────────────────── */

  await t.evaluate(`window.__l = ${log}.length; return true;`)
  await t.drag('#todo li[data-id="4"]', await below('#done li[data-id="5"]', t))
  await t.eventually(state, '2,3,1|5,4|9', 'four moved from todo to the end of done')
  const cross = await t.evaluate(`return ${log}.slice(window.__l);`)
  t.match(cross, /done:c:draggedEntered/, 'done heard the item enter')
  t.match(cross, /todo:c:draggedLeft\b/, 'todo heard it leave')
  t.match(cross, /done:f:droppedIntoZone/, 'done finalized as the zone it landed in')
  t.match(cross, /todo:f:droppedIntoAnother/, 'and todo finalized too, as the list it left')

  /* ── a zone of another type refuses ───────────────────────────────────── */

  await t.drag('#todo li[data-id="2"]', '#other li[data-id="9"]')
  await t.eventually(state, '2,3,1|5,4|9', 'a drop on a list of another type changes nothing')
  t.match(await t.evaluate(`return ${log};`), /todo:f:droppedOutsideOfAny$/, 'and says it landed outside any zone')
  t.ok(!(await t.evaluate(`return ${log};`)).includes('other:'), 'the other type was never told')

  /* ── Escape puts it back ──────────────────────────────────────────────── */

  await t.drag('#todo li[data-id="2"]', '#done li[data-id="5"]', { release: false })
  await t.eventually(`${state}.split('|')[1].split(',').length`, 3, 'mid-drag, done holds the placeholder')
  await t.press('Escape')
  await t.eventually(state, '2,3,1|5,4|9', 'Escape returns it to where it started')
  // The pointer is still down; releasing it must not start or finish anything.
  await t.drag('#done li[data-id="5"]', '#done li[data-id="5"]', { steps: 1 })
  await t.eventually(`document.querySelectorAll('[data-dnd-ghost]').length`, 0, 'and leaves no ghost behind')

  /* ── a control inside an item is a control ────────────────────────────── */

  await t.drag('#todo li[data-id="3"] .poke', await below('#todo li[data-id="1"]', t))
  await t.eventually(state, '2,3,1|5,4|9', 'a press on a button inside an item does not drag')
  await t.clickAt('#todo li[data-id="3"] .poke')
  await t.eventually(`document.getElementById('clicks').textContent`, '1', 'and the button still clicks')
}
