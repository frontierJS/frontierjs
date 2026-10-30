/*
 * confirm-in-drawer.spec.mjs -- a confirmation asked from inside a Drawer.
 *
 * `FJS-1983`: the panel existed and was positioned, but it was portaled to
 * <body>, beneath the drawer's modal <dialog> in the top layer and inert
 * behind it, so the point at its centre hit the drawer. Only a real browser
 * has a top layer, so only a drive can see it.
 */
export const name   = 'Confirmation inside a Drawer'
export const covers = ['overlay/ConfirmPanel', 'overlay/ConfirmProvider', 'overlay/ConfirmationPopover']

const ran   = `document.querySelector('#ran').textContent`
const panel = `document.querySelector('[role=dialog][aria-modal=false]')`

// What a pointer at the centre of the panel would actually hit.
const onTop = `(() => {
  const p = ${panel}
  if (!p) return false
  const r = p.getBoundingClientRect()
  return p.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
})()`

export async function run(t) {
  await t.mount('confirm-in-drawer')

  await t.clickAt('#stage #open-drawer')
  await t.evaluate(`await waitFor(() => document.querySelector('dialog.drawer')?.open); return true;`)
  await t.evaluate(`return await waitVisible('dialog.drawer');`)

  /* -- data-confirm -------------------------------------------------------- */

  await t.clickAt('#remove')
  await t.eventually(`!!${panel}`, true, 'a guarded button in a drawer opens the confirmation')
  await t.eventually(onTop, true, 'and the panel is on top of the drawer, not beneath it')
  await t.clickAt('[role=dialog][aria-modal=false] .btn.danger')
  await t.eventually(ran, 'remove', 'clicking confirm runs the guarded handler')
  await t.eventually(`!!${panel}`, false, 'and closes the panel')
  t.is(await t.evaluate(`return document.querySelector('dialog.drawer').open;`), true,
    'the drawer stays open')

  /* -- ConfirmationPopover ------------------------------------------------- */

  await t.clickAt('#archive')
  await t.eventually(`!!${panel}`, true, 'a ConfirmationPopover in a drawer opens')
  await t.eventually(onTop, true, 'and its panel is on top of the drawer')
  await t.clickAt('[role=dialog][aria-modal=false] .btn.danger')
  await t.eventually(ran, 'remove|archive', 'clicking confirm runs onconfirm')

  /* -- inline -------------------------------------------------------------- */

  // No portal to land beneath the drawer: the prompt is in the dialog already.
  await t.clickAt('#inline-delete')
  await t.eventually(`!!document.querySelector('dialog.drawer [role=group]')`, true,
    'an inline confirmation opens inside the drawer')
  await t.eventually(`!!${panel}`, false, 'and floats no panel')
  await t.clickAt('dialog.drawer [role=group] .btn.danger')
  await t.eventually(ran, 'remove|archive|inline', 'its confirm runs onconfirm')
  await t.eventually(`document.activeElement?.id`, 'inline-delete', 'and focus returns to the trigger')
  t.is(await t.evaluate(`return document.querySelector('dialog.drawer').open;`), true,
    'the drawer stays open')
}
