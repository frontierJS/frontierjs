/*
 * popover.spec.mjs — Popover and ConfirmationPopover.
 *
 * Neither is a `<dialog>`: both portal a panel to `<body>` and position it
 * from the trigger's rect, which means every part of them is behavior this
 * package wrote and a render test sees none of it. The panel is not even in
 * the component's own tree, so a query scoped to the fixture finds nothing and
 * a spec that scopes it reports "closed" for a panel sitting on screen.
 *
 * Three things fail silently here and are asserted separately: the panel
 * OPENING, the panel being placed against the trigger rather than at 0,0, and
 * click-away — which is a capture-phase document listener the component has to
 * remove again, so it is also a leak the next fixture would feel.
 */
export const name = 'Popover · ConfirmationPopover'
export const covers = ['overlay/Popover', 'overlay/ConfirmationPopover']

export async function run(t) {
  /* ── Popover ─────────────────────────────────────────────────────────── */

  await t.mount('popover')

  t.is(await t.evaluate(`return document.querySelectorAll('body > .popover').length;`), 0,
    'a popover starts closed')

  await t.clickAt('#stage #pop-trigger')
  t.ok(await t.evaluate(`return await waitVisible('body > .popover');`),
    'clicking the trigger opens the panel, visible after its entrance')

  t.ok(await t.evaluate(`
    const p = document.querySelector('body > .popover');
    return p.parentElement === document.body;
  `), 'the panel is portaled to <body>, so an overflow:hidden ancestor cannot clip it')

  // Placement is the whole reason this component exists — @frontierjs/css
  // leaves positioning to the consumer. An unplaced fixed panel sits at the
  // top-left of the viewport, which reads as "the popover opened".
  t.ok(await t.evaluate(`
    const trigger = document.querySelector('#pop-trigger').getBoundingClientRect();
    const panel   = document.querySelector('body > .popover').getBoundingClientRect();
    return panel.top > trigger.top && Math.abs(panel.left - trigger.left) < 40 && panel.top > 8;
  `), 'the panel is placed under its trigger, not at the viewport origin')

  t.ok(await t.evaluate(`return !!document.querySelector('body > .popover [id="pop-body"]');`),
    'the content snippet renders inside the panel')

  // Click-away, through the input pipeline. `el.click()` would reach the
  // component's own capture listener too, but a real pointer is what the
  // component is written against.
  await t.clickAt('#outside')
  await t.evaluate(`await waitFor(() => !document.querySelector('body > .popover')); return true;`)
  t.is(await t.evaluate(`return document.querySelectorAll('body > .popover').length;`), 0,
    'clicking away closes it')

  // A second open, then Escape — a separate path through the same close, and
  // the one that proves the window listener survived the first close.
  await t.clickAt('#stage #pop-trigger')
  await t.evaluate(`return await waitVisible('body > .popover');`)
  await t.press('Escape')
  await t.evaluate(`await waitFor(() => !document.querySelector('body > .popover')); return true;`)
  t.is(await t.evaluate(`return document.querySelectorAll('body > .popover').length;`), 0,
    'Escape closes it, and the trigger still works after a click-away close')

  t.ok(await t.evaluate(`return document.activeElement === document.querySelector('#pop-trigger');`),
    'closing returns focus to the trigger')

  /* ── ConfirmationPopover ─────────────────────────────────────────────── */

  await t.mount('confirm-popover')
  await t.clickAt('#stage #confirm-trigger')
  t.ok(await t.evaluate(`return await waitVisible('body > .popover');`),
    'the confirmation opens')

  t.ok(await t.evaluate(`
    const p = document.querySelector('body > .popover');
    return p.getAttribute('role') === 'dialog' && p.getAttribute('aria-modal') === 'false'
        && !!p.getAttribute('aria-labelledby');
  `), 'it announces itself as a non-modal dialog with a name')

  t.ok(await t.evaluate(`
    const p = document.querySelector('body > .popover');
    return p.contains(document.activeElement) && document.activeElement.textContent.trim() === 'Remove';
  `), 'focus lands on the confirm button')

  // Cancel and confirm are counted separately: a wiring that fires both, or
  // the wrong one, looks identical on screen.
  await t.clickAt('body > .popover .btn.ghost')
  await t.eventually(`document.querySelector('#cancels').textContent`, '1', 'Cancel fires oncancel')
  await t.eventually(`document.querySelector('#confirms').textContent`, '0', 'Cancel does not confirm')

  await t.clickAt('#stage #confirm-trigger')
  await t.evaluate(`return await waitVisible('body > .popover');`)
  await t.clickAt('body > .popover .btn.danger')
  await t.eventually(`document.querySelector('#confirms').textContent`, '1', 'Remove fires onconfirm')
  await t.evaluate(`await waitFor(() => !document.querySelector('body > .popover')); return true;`)
  t.is(await t.evaluate(`return document.querySelectorAll('body > .popover').length;`), 0,
    'confirming closes the panel')

  // The capture listener is added on open and removed on close and on destroy.
  // One left behind swallows the NEXT fixture's first click, which reads as a
  // component that stopped responding.
  await t.clickAt('#stage #confirm-trigger')
  await t.evaluate(`return await waitVisible('body > .popover');`)
  await t.evaluate(`return window.kitUnmount();`)
  t.is(await t.evaluate(`return document.querySelectorAll('body > .popover').length;`), 0,
    'unmounting takes the portaled panel with it')
}
