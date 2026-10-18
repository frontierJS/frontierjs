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

  // A click-away that lands on another field is that field's focus to keep.
  // Closing restored focus to the trigger after the press had moved it, so the
  // person clicked into a box and was sent back to a button (`FJS-2894`).
  await t.clickAt('#stage #pop-trigger')
  await t.evaluate(`return await waitVisible('body > .popover');`)
  await t.clickAt('#outside-input')
  await t.evaluate(`await waitFor(() => !document.querySelector('body > .popover')); return true;`)
  t.ok(await t.evaluate(`return document.activeElement === document.querySelector('#outside-input');`),
    'clicking away onto a field closes it and leaves focus on that field')

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

  // A terminal node has no querySelector, so the close must come back to the
  // control it saw take focus rather than ask the wrapper for one.
  await t.evaluate(`
    const wrap = document.querySelector('#pop-trigger').parentElement;
    Object.defineProperty(wrap, 'querySelector', { value: undefined });
    document.activeElement.blur();
    return true;
  `)
  await t.clickAt('#stage #pop-trigger')
  await t.evaluate(`return await waitVisible('body > .popover');`)
  await t.press('Escape')
  await t.evaluate(`await waitFor(() => !document.querySelector('body > .popover')); return true;`)
  t.ok(await t.evaluate(`return document.activeElement === document.querySelector('#pop-trigger');`),
    'closing a trigger that cannot be queried returns focus to the control it held')

  // `top-start` was declared and never read — the side came from overflow
  // alone — so it opened below. The fixture's 6rem of padding is room enough
  // for this panel, which is the premise asserted first.
  await t.mount('popover', { placement: 'top-start' })
  await t.clickAt('#stage #pop-trigger')
  await t.evaluate(`return await waitVisible('body > .popover');`)
  await t.evaluate(`return await waitSettled('body');`)
  const top = await t.evaluate(`
    const tr = document.querySelector('#pop-trigger').getBoundingClientRect();
    const p  = document.querySelector('body > .popover').getBoundingClientRect();
    return { roomAbove: Math.round(tr.top), height: Math.round(p.height), above: p.bottom <= tr.top + 1 };
  `)
  t.ok(top.roomAbove > top.height,
    `the premise: the panel fits above (${top.roomAbove}px for ${top.height}px)`)
  t.ok(top.above, 'placement="top-start" opens the panel above its trigger')
  await t.press('Escape')

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

  // The two ways out that are not a button. Escape is TAKEN: a host that also
  // answers Escape, the terminal shell going back a screen, reads
  // defaultPrevented to know the panel had it.
  await t.clickAt('#stage #confirm-trigger')
  await t.evaluate(`return await waitVisible('body > .popover');`)
  await t.clickAt('#outside')
  await t.eventually(`document.querySelector('#cancels').textContent`, '2', 'a click outside cancels')
  await t.evaluate(`await waitFor(() => !document.querySelector('body > .popover')); return true;`)

  await t.clickAt('#stage #confirm-trigger')
  await t.evaluate(`return await waitVisible('body > .popover');`)
  await t.evaluate(`
    window.__escTaken = null;
    window.addEventListener('keydown', (e) => { window.__escTaken = e.defaultPrevented }, { once: true });
    return true;
  `)
  await t.press('Escape')
  await t.eventually(`document.querySelector('#cancels').textContent`, '3', 'Escape cancels')
  t.is(await t.evaluate(`return window.__escTaken;`), true, 'and takes the key')
  await t.evaluate(`await waitFor(() => !document.querySelector('body > .popover')); return true;`)

  // The window listener goes with the panel. One left behind swallows the
  // NEXT fixture's first click, which reads as a component that stopped
  // responding.
  await t.clickAt('#stage #confirm-trigger')
  await t.evaluate(`return await waitVisible('body > .popover');`)
  await t.evaluate(`return window.kitUnmount();`)
  t.is(await t.evaluate(`return document.querySelectorAll('body > .popover').length;`), 0,
    'unmounting takes the portaled panel with it')
}
