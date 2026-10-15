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
const _reset = `document.getElementById('log').textContent`

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

  /* ── the keyboard: Space lifts, arrows move, Space drops ───────────────── */

  const focus = (sel) => t.evaluate(`document.querySelector(${JSON.stringify(sel)}).focus(); return true;`)
  const live  = `(document.querySelector('[data-dnd-live]') || {}).textContent || ''`
  const active = `document.activeElement.dataset.id || ''`
  const ph = 'id:dnd-shadow-placeholder-0000'
  await t.evaluate(`window.__l = ${log}.length; return true;`)
  await focus('#todo li[data-id="2"]')
  await t.press(' ')
  await t.eventually(`${log}.slice(window.__l).includes('todo:c:dragStarted')`, true, 'Space on a focused item lifts it')
  t.match(await t.evaluate(`return ${live};`), /position 1 of 3/, 'and a live region says where it is')
  await t.press('ArrowDown')
  await t.press('ArrowDown')
  await t.eventually(state, `3,1,${ph}|5,4|9`, 'two ArrowDowns move the placeholder two places')
  t.match(await t.evaluate(`return ${live};`), /position 3 of 3/, 'and the new position is announced')
  t.is(await t.evaluate(`return ${active};`), ph, 'focus stays on the moving item, which is the placeholder mid-lift')
  await t.press('ArrowDown')
  t.is(await t.evaluate(`return ${state};`), `3,1,${ph}|5,4|9`, 'the end of the list is a wall')
  await t.press(' ')
  await t.eventually(`${log}.slice(window.__l).endsWith('todo:f:droppedIntoZone')`, true, 'Space drops it and finalizes once')
  t.is(await t.evaluate(`return document.getElementById('state').textContent;`), '3,1,2|5,4|9', 'the list holds the new order')
  t.is(await t.evaluate(`return document.getElementById('sources').textContent.split(' ').slice(-4).join(' ');`),
    'keyboard keyboard keyboard keyboard', 'every callback reported the keyboard as its source')
  await t.eventually(active, '2', 'focus returns to the dropped item')
  t.is(await t.evaluate(`return document.querySelectorAll('[data-dnd-target], [data-dnd-shadow]').length;`), 0,
    'and no zone or item is left marked')

  await t.press('ArrowUp')   // idle: an arrow with nothing lifted is the page's
  t.is(await t.evaluate(`return ${state};`), '3,1,2|5,4|9', 'arrows move nothing until an item is lifted')

  await t.press(' ')
  await t.press('ArrowUp')
  await t.eventually(state, `3,${ph},1|5,4|9`, 'ArrowUp moves it back')
  await t.press('Escape')
  await t.eventually(state, '3,1,2|5,4|9', 'Escape puts it back where it was lifted')
  t.match(await t.evaluate(`return ${live};`), /cancel/i, 'and says so')
  await t.eventually(active, '2', 'with focus on the item again')
  /* ── a wrapped row is indexed by line, then along it ──────────────────── */

  // Nine chips, three to a line. One axis reads the pointer on the third line
  // against the first chip's x and drew the placeholder at index 0.
  const wstate = `document.getElementById('wstate').textContent`
  const leftOf = (sel) => t.evaluate(`
    const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
    return { x: r.left + 3, y: r.top + r.height / 2 };
  `)
  t.is(await t.evaluate(`return ${wstate};`), '1,2,3,4,5,6,7,8,9', 'the chips start in order')
  await t.drag('#wrap li[data-id="1"]', await leftOf('#wrap li[data-id="7"]'))
  await t.eventually(wstate, '2,3,4,5,6,1,7,8,9', 'a chip dropped at the left of the third line lands before that line\'s first chip')
  await t.drag('#wrap li[data-id="9"]', await leftOf('#wrap li[data-id="2"]'))
  await t.eventually(wstate, '9,2,3,4,5,6,1,7,8', 'and one dropped at the left of the first line lands first')

  /* ── a column-wrap and a grid are indexed by line too ─────────────────── */

  // Nine chips, three to a COLUMN. Read as one axis the pointer in the third
  // column sat against the first chip's y and drew the placeholder at index 0.
  const aboveOf = (sel) => t.evaluate(`
    const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 3 };
  `)
  const cstate = `document.getElementById('cstate').textContent`
  t.is(await t.evaluate(`return ${cstate};`), '1,2,3,4,5,6,7,8,9', 'the column-wrap chips start in order')
  await t.drag('#cwrap li[data-id="1"]', await aboveOf('#cwrap li[data-id="7"]'))
  await t.eventually(cstate, '2,3,4,5,6,1,7,8,9', 'a chip dropped at the top of the third column lands before that column\'s first chip')
  await t.drag('#cwrap li[data-id="9"]', await aboveOf('#cwrap li[data-id="2"]'))
  await t.eventually(cstate, '9,2,3,4,5,6,1,7,8', 'and one dropped at the top of the first column lands first')

  /* ── a zone clipped out of view by a scroller takes no drop ───────────── */

  // The second lane lies wholly outside the scroller's box: its rectangle is
  // real, but the pixels over it are the page's. A rectangle-only hit test put
  // the card in the lane the user could not see.
  const clstate = `document.getElementById('clstate').textContent`
  t.is(await t.evaluate(`return ${clstate};`), '21,22|31,32', 'the clipped lanes start as the fixture wrote them')
  const centerOf = (sel) => t.evaluate(`
    const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `)
  // Two steps, so the pointer never crosses the scroller's edge zone and autoscrolls it.
  await t.drag('#clipa li[data-id="21"]', await centerOf('#clipb li[data-id="31"]'), { steps: 2 })
  await t.evaluate('await new Promise(r => setTimeout(r, 400)); return true;')
  await t.eventually(clstate, '21,22|31,32', 'a drop over a lane the scroller clips away changes nothing')
  await t.evaluate(`document.getElementById('clip').scrollLeft = 1000; return true;`)
  await t.drag('#clipb li[data-id="32"]', await aboveOf('#clipb li[data-id="31"]'))
  await t.eventually(clstate, '21,22|32,31', 'and the same lane takes a drop once it is scrolled into view')

  const gstate = `document.getElementById('gstate').textContent`
  t.is(await t.evaluate(`return ${gstate};`), '1,2,3,4,5,6,7,8,9', 'the grid cells start in order')
  await t.drag('#grid li[data-id="1"]', await leftOf('#grid li[data-id="7"]'))
  await t.eventually(gstate, '2,3,4,5,6,1,7,8,9', 'a cell dropped at the left of the third row lands before that row\'s first cell')
  await t.drag('#grid li[data-id="9"]', await leftOf('#grid li[data-id="2"]'))
  await t.eventually(gstate, '9,2,3,4,5,6,1,7,8', 'and one dropped at the left of the first row lands first')
}
