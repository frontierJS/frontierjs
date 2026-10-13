/*
 * dnd-live.spec.mjs — a target list replaced mid-drag, then a drop in place.
 *
 * The push arrives with no placeholder in it, so the drop has nowhere to land.
 * Unfixed, both onfinalize lists left the dragged item out — done:5,6 and
 * todo:1,2,3 — and a host persisting from onfinalize, as documented, deleted
 * the record (`FJS-2583`). What is asserted is what that host ends up holding.
 */
export const name = 'dndzone — a list replaced under the drag'
export const covers = []

const state = `document.getElementById('state').textContent`
const log   = `document.getElementById('log').textContent`

export async function run(t) {
  await t.mount('dnd-live')
  t.is(await t.evaluate(`return ${state};`), '1,2,3,4|5', 'the lists start as the fixture wrote them')

  const at = await t.evaluate(`
    const r = document.querySelector('#done li[data-id="5"]').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.bottom - 2 };
  `)
  await t.drag('#todo li[data-id="4"]', at, { release: false })
  await t.eventually(`${state}.split('|')[1].split(',').length`, 2, 'mid-drag, done holds the placeholder')

  await t.evaluate(`window.kitPushDone(); return true;`)
  await t.eventually(`${state}.split('|')[1].split(',').filter(Boolean).length`, 3,
    'the pushed list takes the placeholder back beside its two rows')

  await t.drag(at, at, { steps: 1, press: false })
  // The drop animates before it settles, so the lists are read once it has.
  await t.eventually(`document.querySelectorAll('[data-dnd-ghost]').length`, 0, 'the drop settled')
  t.is(await t.evaluate(`return ${state};`).then((s) => s.split('|')[0]), '1,2,3', 'four left todo')
  t.is((await t.evaluate(`return ${state};`)).split('|')[1].split(',').sort().join(','), '4,5,6',
    'and landed in done beside the pushed rows — in neither list is it lost')
  t.match(await t.evaluate(`return ${log};`), /done:f:droppedIntoZone:[\d,]*4/,
    'the list done finalizes carries the dragged item')

  /* ── the push in the frame of the drop ────────────────────────────────── */

  // No hit test runs between the push and the drop, so nothing but the fix
  // can put the placeholder back. This is the case that lost the record.
  const first = await t.evaluate(`
    const r = document.querySelector('#done li').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.bottom - 2 };
  `)
  await t.drag('#todo li[data-id="3"]', first, { release: false })
  await t.eventually(`${state}.split('|')[0]`, '1,2', 'mid-drag, three has left todo')
  await t.evaluate(`window.kitPushOnRelease(); return true;`)
  await t.drag(first, first, { steps: 0, press: false })
  await t.eventually(`document.querySelectorAll('[data-dnd-ghost]').length`, 0, 'the second drop settled')
  t.is((await t.evaluate(`return ${state};`)).split('|')[1].split(',').sort().join(','), '3,5,6',
    'three is in the pushed list')
  t.match(await t.evaluate(`return ${log};`), /done:f:droppedIntoZone:[\d,]*\b3\b[\d,]* todo:f:droppedIntoAnother:1,2$/,
    'and in the list done finalized with, which is what a host saves')
}
