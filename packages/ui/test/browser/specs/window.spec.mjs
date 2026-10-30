/*
 * window.spec.mjs -- Window, the non-modal floating panel (FJS-3618).
 *
 * A render test sees identical markup whether the move works or not. What is
 * owned here: the page stays live under it, a real pointer drag and the arrow
 * keys write `box` and report once per finished gesture, and the launcher reopens a shut one.
 */
export const name = 'Window -- non-modal, move, resize, dock, launcher'
export const covers = ['overlay/Window']

const rect = `const r = document.querySelector('section.fjs-window').getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };`
const read = (id) => `document.querySelector('#${id}').textContent`

export async function run(t) {
  await t.mount('window')

  t.ok(await t.evaluate(`return !!document.querySelector('section.fjs-window[role=dialog][aria-modal=false]');`),
    'it opens as a non-modal dialog')
  t.is(await t.evaluate(`return document.querySelector('section.fjs-window').matches(':modal');`), false,
    'and is not in the modal top layer, so the page stays live')
  t.ok(await t.evaluate(`const b = document.querySelector('.fjs-window-bar #pop-out');
    return !!b && b.nextElementSibling?.classList.contains('dialog-close');`),
    'the action snippet renders in the title bar, before the close button')

  const before = await t.evaluate(rect)

  /* ── move by title bar ─────────────────────────────────────────────── */
  const title = await t.evaluate(`const r = document.querySelector('.fjs-window-title').getBoundingClientRect();
    return { x: r.left + 20, y: r.top + 8 };`)
  await t.drag(title, { x: title.x - 100, y: title.y - 60 }, { steps: 6 })
  const moved = await t.evaluate(rect)
  t.is(Math.round(before.x - moved.x), 100, 'a drag on the title bar moves it by the pointer distance (x)')
  t.is(Math.round(before.y - moved.y), 60, 'and (y)')
  t.is(await t.evaluate(`return ${read('changes')};`), '1', 'onchange fires once at the end of the gesture')
  t.match(await t.evaluate(`return ${read('box')};`), /"x":/, 'and bind:box carries the box')

  /* ── resize by grip ────────────────────────────────────────────────── */
  const grip = await t.evaluate(`const r = document.querySelector('.fjs-window-grip').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`)
  await t.drag(grip, { x: grip.x - 40, y: grip.y - 30 }, { steps: 4 })
  const sized = await t.evaluate(rect)
  t.is(Math.round(moved.w - sized.w), 40, 'the grip resizes (w)')
  t.is(Math.round(moved.h - sized.h), 30, 'and (h)')
  t.is(await t.evaluate(`return ${read('changes')};`), '2', 'one more report')

  /* ── arrow keys: one press, one finished gesture ───────────────────── */
  await t.evaluate(`document.querySelector('.fjs-window-title').focus(); return true;`)
  await t.press('ArrowRight')
  const keyed = await t.evaluate(rect)
  t.is(Math.round(keyed.x - sized.x), 32, 'ArrowRight on the title bar moves 32px')

  /* ── the page behind keeps working ─────────────────────────────────── */
  t.ok(await t.evaluate(`return document.querySelector('#page-text').closest('[inert]') === null;`),
    'the page is not inert')

  /* ── close, then the launcher ──────────────────────────────────────── */
  await t.clickAt('.fjs-window .dialog-close')
  await t.eventually(read('state'), 'shut', 'the close button writes back through bind:open')
  t.ok(await t.evaluate(`return !document.querySelector('section.fjs-window');`), 'and removes the window')
  await t.clickAt('.fjs-window-launcher')
  await t.eventually(read('state'), 'open', 'the launcher reopens it')

  /* ── docked ────────────────────────────────────────────────────────── */
  await t.mount('window', { dock: 'right' })
  const docked = await t.evaluate(rect)
  t.is(Math.round(docked.x + docked.w), await t.evaluate(`return document.documentElement.getBoundingClientRect().width;`), 'dock="right" pins it to the right edge')
  t.is(Math.round(docked.h), await t.evaluate(`return innerHeight;`), 'and spans the viewport')
  const edge = await t.evaluate(`const r = document.querySelector('.fjs-window-grip').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`)
  await t.drag(edge, { x: edge.x - 50, y: edge.y }, { steps: 4 })
  const wider = await t.evaluate(rect)
  t.is(Math.round(wider.w - docked.w), 50, 'its inner-edge grip resizes the thickness')
  t.is(Math.round(wider.x + wider.w), Math.round(docked.x + docked.w), 'and stays on the edge')
}
