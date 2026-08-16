/*
 * modal.spec.mjs — Modal.
 *
 * Modal is opened on real screens by `example`'s `verify:ui`, which asserts
 * that focus lands inside the `<dialog>`. That is one half. The other half is
 * what happens on the way OUT — Escape, the backdrop, the close button — and
 * all three of those run through the `close` event, which does not bubble.
 * The kit shipped with that handler delegated, so a modal closed by Escape
 * left the caller's `open` at `true` and could never be reopened; the drive
 * that covered the component never asked.
 *
 * The rest is the platform's, and asserting the platform is the point: this
 * component exists to delete a hand-rolled focus trap, so what has to be true
 * is that showModal() was actually used.
 */
export const name = 'Modal'
export const covers = ['overlay/Modal']

export async function run(t) {
  await t.mount('modal')

  await t.clickAt('#stage #open-modal')
  t.ok(await t.evaluate(`return await waitVisible('dialog.dialog');`),
    'opening puts the modal on screen')

  // Inertness is the difference between showModal() and show(), and it is
  // invisible until something outside the dialog is clicked.
  t.ok(await t.evaluate(`
    const outside = document.querySelector('#outside-modal');
    const r = outside.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + 2, r.top + 2);
    return hit !== outside;
  `), 'the rest of the page is inert behind the modal')

  t.ok(await t.evaluate(`
    return document.querySelector('dialog.dialog').contains(document.activeElement);
  `), 'focus starts inside the dialog')

  // The focus trap: Tab from the last control wraps to the first rather than
  // leaving for the page behind. Nothing but a real Tab through the input
  // pipeline moves focus.
  const trapped = await t.evaluate(`
    const d = document.querySelector('dialog.dialog');
    document.querySelector('#cancel').focus();
    return d.contains(document.activeElement);
  `)
  t.ok(trapped, 'the footer control is reachable')

  // Tabbing round the cycle and asserting what focus never REACHES, rather
  // than what it holds at each step: Chrome's own wrap passes through
  // document.body on its way back into the dialog, so a step-by-step
  // "still inside" check reports a working trap as broken.
  const visited = []
  for (let i = 0; i < 5; i++) {
    await t.press('Tab')
    visited.push(await t.evaluate(`return { id: document.activeElement.id };`))
  }
  const ids = visited.map((v) => v.id)
  t.ok(!ids.includes('outside-modal') && !ids.includes('open-modal'),
    'Tab never reaches a control behind the modal')
  t.ok(ids.includes('cancel') && ids.includes('in-body'),
    'Tab cycles through the dialog\'s own controls')

  await t.press('Escape')
  await t.eventually(`document.querySelector('#state').textContent`, 'shut',
    'Escape writes back through bind:open')
  await t.eventually(`document.querySelector('#closes').textContent`, '1', 'onclose fires once')

  // Reopening is the assertion the writeback exists FOR. With `open` stuck at
  // true, this second click sets it to a value it already holds, the watcher
  // never fires, and the modal is gone for the life of the page.
  await t.clickAt('#stage #open-modal')
  t.ok(await t.evaluate(`return await waitVisible('dialog.dialog');`),
    'it can be reopened after being dismissed')

  // A click on the backdrop is a click on the dialog element itself — the
  // padding box outside `.surface-*` — which is why the component tests
  // `e.target === dialogEl` rather than hit-testing a backdrop node.
  await t.evaluate(`
    const d = document.querySelector('dialog.dialog');
    const r = d.getBoundingClientRect();
    return { x: r.left, y: r.top };
  `)
  await t.evaluate(`
    const d = document.querySelector('dialog.dialog');
    d.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  `)
  await t.eventually(`document.querySelector('#state').textContent`, 'shut',
    'a click on the dialog itself — the backdrop — dismisses it')

  /* ── dismissible: false ──────────────────────────────────────────────── */

  await t.mount('modal', { dismissible: false })
  await t.clickAt('#stage #open-modal')
  await t.evaluate(`return await waitVisible('dialog.dialog');`)
  await t.press('Escape')
  await t.evaluate(`await new Promise(r => setTimeout(r, 120)); return true;`)
  t.ok(await t.evaluate(`return document.querySelector('dialog.dialog').open;`),
    'dismissible={false} refuses Escape')
}
