/*
 * select-viewport.spec.mjs — a Combobox and a MultiSelect near the window's
 * foot open on the side that holds their list, inside the window
 * (`FJS-4103`). Both hung a fixed 12rem panel off the control by CSS and
 * never asked where the window ended.
 */
export const name = 'a combobox and a multiselect near the window foot keep their panel inside it'
export const covers = ['forms/Combobox', 'forms/MultiSelect']

export async function run(t) {
  await t.mount('select-viewport')

  for (const id of ['combo', 'multi']) {
    await t.clickAt(`#${id} input`)
    await t.evaluate(`return await waitVisible('#${id} .popover');`)
    await t.eventually(`(() => {
      const p = document.querySelector('#${id} .popover').getBoundingClientRect()
      const c = document.querySelector('#${id} input').getBoundingClientRect()
      return p.bottom <= innerHeight && p.top >= 0 && p.bottom <= c.top
    })()`, true, `${id}: the panel opens above the control, inside the window`)
    await t.press('Escape')
  }
}
