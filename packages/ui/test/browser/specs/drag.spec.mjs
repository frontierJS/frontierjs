/*
 * drag.spec.mjs — the `drag` attachment, driven by a real pointer.
 *
 * What a hand-written drag gets wrong is only visible with a real pointer and
 * real capture: a release past the element's edge, and a drag the browser
 * takes away. Each is asserted on what the fixture's own callbacks recorded.
 */
export const name = 'drag — capture past the edge, cancel, one start per drag'
export const covers = []

const read = (id) => `document.getElementById('${id}').textContent`

export async function run(t) {
  await t.mount('drag')

  /* ── a release far past the element still ends the drag ─────────────── */

  const r = await t.evaluate(`const b = document.getElementById('box').getBoundingClientRect(); return { x: b.left + 40, y: b.top + 40 };`)
  await t.drag('#box', { x: r.x + 300, y: r.y + 10 })
  await t.eventually(read('ends'), 'up@0', 'a release 260px outside the box ends it as a release')
  t.is(await t.evaluate(`return ${read('moved')};`), '300,10', 'and every move reached it, past the edge, as distance from the press')
  t.is(await t.evaluate(`return ${read('starts')};`), '1', 'one start, though the state its callbacks read changed on every move')

  /* ── the capture taken away is a cancel, not a stuck drag ───────────── */

  await t.drag('#box', { x: r.x + 20, y: r.y + 20 }, { release: false })
  const before = await t.evaluate(`return ${read('moved')};`)
  // Chrome fires lostpointercapture when it next processes a pointer event,
  // so the move after the release is what delivers it -- and that move must
  // reach no drag, since the drag ended first.
  await t.evaluate(`document.getElementById('box').releasePointerCapture(window.__pid); return true;`)
  await t.drag({ x: r.x + 20, y: r.y + 20 }, { x: r.x + 90, y: r.y + 90 }, { press: false, release: false })
  await t.eventually(`${read('ends')}.split(' ').length`, 2, 'a lost capture ends the drag')
  t.match(await t.evaluate(`return ${read('ends')};`), /cancel@\d+$/, 'and reports it cancelled')
  t.is(await t.evaluate(`return ${read('moved')};`), before, 'and the moves after it report nothing')
  await t.drag({ x: r.x + 90, y: r.y + 90 }, { x: r.x + 90, y: r.y + 90 }, { press: false, steps: 1 })
  t.is(await t.evaluate(`return ${read('ends')}.split(' ').length;`), 2, 'and the release that follows ends nothing twice')
}
