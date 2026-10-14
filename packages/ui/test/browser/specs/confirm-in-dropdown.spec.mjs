/*
 * confirm-in-dropdown.spec.mjs -- a data-confirm row inside a DropdownMenu.
 *
 * `FJS-2830`: choosing the row opens the confirmation, and pressing its
 * confirm button is a click outside the menu, which closes the menu and
 * unmounts the row before ConfirmProvider re-fires the click on it -- so the
 * guarded handler never ran.
 */
export const name   = 'Confirmation from a DropdownMenu row'
export const covers = ['overlay/DropdownMenu', 'overlay/DropdownItem', 'overlay/ConfirmProvider']

const ran   = `document.querySelector('#ran').textContent`
const panel = `document.querySelector('[role=dialog][aria-modal=false]')`

export async function run(t) {
  await t.mount('confirm-in-dropdown')

  await t.clickAt('#stage #more')
  await t.evaluate(`return await waitVisible('#remove');`)
  await t.clickAt('#remove')
  await t.eventually(`!!${panel}`, true, 'a guarded menu row opens the confirmation')
  t.is(await t.evaluate(`return ${ran};`), '', 'and the handler has not run yet')
  await t.clickAt('[role=dialog][aria-modal=false] .btn.danger')
  await t.eventually(ran, 'remove', 'confirming runs the row\'s handler')
  await t.eventually(`!!${panel}`, false, 'and closes the panel')
}
