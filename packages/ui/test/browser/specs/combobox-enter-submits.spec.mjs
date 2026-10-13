/*
 * combobox-enter-submits.spec.mjs — Enter in a combobox picks a row while the
 * list is open and submits the form once it is closed.
 *
 * The keydown handler refused Enter's default unconditionally, so a form whose
 * last field was a picker could never be submitted from the keyboard: the
 * list closed on the pick and every Enter after it was swallowed with nothing
 * to do (`FJS-2789`).
 */
export const name = 'Enter in a combobox: pick while open, submit once closed'
export const covers = ['forms/Combobox']

const read = (id) => `document.querySelector('#${id}').textContent`

export async function run(t) {
  await t.mount('combobox-enter-submits')

  // Focus opens the list; Enter takes the active row and must not also submit.
  await t.clickAt('#f input[role=combobox]')
  await t.evaluate(`return await waitVisible('#f [role=option]');`)
  await t.press('Enter')
  await t.eventually(read('value'), 'a', 'Enter on an open list picks the active row')
  await t.eventually(read('submits'), '0', 'and does not submit the form')

  await t.press('Enter')
  await t.eventually(read('submits'), '1', 'Enter on a closed list submits the form')

  // Typing reopens the list, so Enter is the picker's again. The box holds
  // the picked label; select it so the typing replaces it.
  await t.evaluate(`document.querySelector('#f input[role=combobox]').select()`)
  await t.type('Br')
  await t.evaluate(`return await waitVisible('#f [role=option]');`)
  await t.press('Enter')
  await t.eventually(read('value'), 'b', 'Enter after typing picks the filtered row')
  await t.eventually(read('submits'), '1', 'and does not submit')

  await t.press('Escape')
  await t.press('Enter')
  await t.eventually(read('submits'), '2', 'Enter after Escape closed the list submits')
}
