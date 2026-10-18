/*
 * dnd-destroy.spec.mjs — a zone removed from the page while an item is held.
 *
 * The cleanup of a zone runs under a live session. Destroying the zone the
 * item hovers cancels to the origin; destroying the origin leaves nowhere to
 * cancel to, so nothing is released to anyone (`FJS-2894`).
 */
export const name = 'dndzone — a zone destroyed mid-drag'
export const covers = []

const state = `document.getElementById('state').textContent`
const log   = `document.getElementById('log').textContent`

const into = (sel, t) => t.evaluate(`
  const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.bottom - 2 };
`)

export async function run(t) {
  /* ── the zone it hovers goes: back to where it started ────────────────── */

  await t.mount('dnd-destroy')
  t.is(await t.evaluate(`return ${state};`), '1,2|5', 'the lists start as the fixture wrote them')

  await t.drag('#a li[data-id="1"]', await into('#b li[data-id="5"]', t), { release: false })
  await t.eventually(`${state}.split('|')[1].split(',').length`, 2, 'mid-drag, b holds the placeholder')
  await t.evaluate(`window.kitHide(false, true); return true;`)
  await t.eventually(`document.querySelectorAll('#b').length`, 0, 'b is gone')
  // a held one row while the item was away; the cancel puts the placeholder back.
  await t.eventually(`${state}.split('|')[0].split(',').length`, 2, 'a takes the placeholder back at the item\'s origin')

  await t.drag(await into('#a li[data-id="2"]', t), await into('#a li[data-id="2"]', t), { steps: 1, press: false })
  await t.eventually(`document.querySelectorAll('[data-dnd-ghost]').length`, 0, 'the ghost is gone')
  t.is(await t.evaluate(`return ${state}.split('|')[0];`), '1,2', 'the item is back in a, in its own place')
  t.match(await t.evaluate(`return ${log};`), /a:f:droppedOutsideOfAny$/, 'a was told it was cancelled')

  /* ── the origin goes while the item is over another zone: the drop stands ─ */

  await t.mount('dnd-destroy')
  await t.drag('#a li[data-id="1"]', await into('#b li[data-id="5"]', t), { release: false })
  await t.eventually(`${state}.split('|')[1].split(',').length`, 2, 'mid-drag again, b holds the placeholder')
  await t.evaluate(`window.kitHide(true, false); return true;`)
  await t.eventually(`document.querySelectorAll('#a').length`, 0, 'a, the origin, is gone')
  await t.eventually(`document.querySelectorAll('[data-dnd-ghost]').length`, 0, 'the ghost went with the drag')
  t.match(await t.evaluate(`return ${log};`), /b:f:droppedIntoZone/, 'b finalizes the drop the person saw')
  t.ok((await t.evaluate(`return ${state};`)).split('|')[1].split(',').includes('1'), 'and holds the item')

  /* ── the origin goes with the item over it: nothing is released ───────── */

  await t.mount('dnd-destroy')
  await t.drag('#a li[data-id="1"]', await into('#a li[data-id="2"]', t), { release: false })
  await t.eventually(`document.querySelectorAll('[data-dnd-ghost]').length`, 1, 'mid-drag over its own list')
  await t.evaluate(`window.kitHide(true, false); return true;`)
  await t.eventually(`document.querySelectorAll('#a').length`, 0, 'a, the origin, is gone')
  await t.eventually(`document.querySelectorAll('[data-dnd-ghost]').length`, 0, 'the ghost went with the drag')
  t.is(await t.evaluate(`return ${log};`), '', 'no zone was told anything was released')
}
