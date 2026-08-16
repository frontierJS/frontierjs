/*
 * drawer.spec.mjs — Drawer, opened for the first time.
 *
 * Drawer is a native `<dialog>` opened with `showModal()`, so the focus trap,
 * Escape and the backdrop come from the platform. What this package owns is
 * the three things around that: the edge class, the `bind:open` round trip,
 * and `dismissible` — which has to refuse Escape, a thing no render test can
 * see because the markup is identical either way.
 */
export const name = 'Drawer'
export const covers = ['overlay/Drawer']

export async function run(t) {
  await t.mount('drawer')

  t.is(await t.evaluate(`return document.querySelector('#stage dialog')?.open ?? false;`), false,
    'a drawer starts closed')

  await t.clickAt('#stage #open-drawer')
  await t.evaluate(`await waitFor(() => document.querySelector('dialog.drawer')?.open); return true;`)

  t.ok(await t.evaluate(`return await waitVisible('dialog.drawer');`),
    'opening puts the drawer on screen')

  // The top layer is the reason a drawer needs no z-index at all. A dialog
  // opened with show() rather than showModal() renders in flow, looks nearly
  // right, and is covered by the next positioned thing on the page.
  t.ok(await t.evaluate(`
    const d = document.querySelector('dialog.drawer');
    const r = d.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + 20) === d
        || d.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 20));
  `), 'the drawer is in the top layer, not behind the page')

  t.ok(await t.evaluate(`
    const d = document.querySelector('dialog.drawer');
    return d.contains(document.activeElement) && document.activeElement !== document.body;
  `), 'focus moves inside the drawer')

  // Escape goes through the input pipeline: a dispatched KeyboardEvent is not
  // trusted, and the `cancel` event this asserts is fired by the browser, not
  // by the component.
  await t.press('Escape')
  await t.evaluate(`await waitFor(() => !document.querySelector('dialog.drawer').open); return true;`)

  await t.eventually(`document.querySelector('#state').textContent`, 'shut',
    'Escape writes back through bind:open')
  await t.eventually(`document.querySelector('#closes').textContent`, '1',
    'onclose fires once')

  // The close button is the other path to the same state, and it is the one
  // `dismissible` also governs.
  await t.clickAt('#stage #open-drawer')
  await t.evaluate(`await waitFor(() => document.querySelector('dialog.drawer').open); return true;`)
  await t.clickAt('dialog.drawer .dialog-close')
  await t.evaluate(`await waitFor(() => !document.querySelector('dialog.drawer').open); return true;`)
  await t.eventually(`document.querySelector('#closes').textContent`, '2',
    'the close button closes it too')

  /* ── every edge ──────────────────────────────────────────────────────
   *
   * `side` is snapshot at mount by design, so each edge is a fresh fixture.
   * The class is the whole geometry — drawers.css owns the slide — so an edge
   * that does not reach the DOM is a drawer that opens from the wrong side
   * and throws nothing.
   */
  for (const [side, expected] of [['left', 'from-left'], ['top', 'from-top'], ['bottom', 'from-bottom']]) {
    await t.mount('drawer', { side })
    await t.clickAt('#stage #open-drawer')
    await t.evaluate(`await waitFor(() => document.querySelector('dialog.drawer').open); return true;`)
    t.ok(await t.evaluate(`return document.querySelector('dialog.drawer').classList.contains(${JSON.stringify(expected)});`),
      `side="${side}" renders .${expected}`)
    t.ok(await t.evaluate(`return await waitVisible('dialog.drawer');`),
      `a drawer from the ${side} is actually on screen`)
    await t.press('Escape')
  }

  /* ── dismissible: false ──────────────────────────────────────────────── */

  await t.mount('drawer', { dismissible: false })
  await t.clickAt('#stage #open-drawer')
  await t.evaluate(`await waitFor(() => document.querySelector('dialog.drawer').open); return true;`)
  await t.press('Escape')
  // No waitFor here: the assertion is that nothing happens, and waiting for a
  // non-event can only time out.
  await t.evaluate(`await new Promise(r => setTimeout(r, 120)); return true;`)

  t.ok(await t.evaluate(`return document.querySelector('dialog.drawer').open;`),
    'dismissible={false} refuses Escape')
  t.ok(await t.evaluate(`return !document.querySelector('dialog.drawer .dialog-close');`),
    'dismissible={false} renders no close button')
}
