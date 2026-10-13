/*
 * picker-enter-submits.spec.mjs — Enter in a picker takes a row while the list
 * is open and submits the form once it is closed.
 *
 * Combobox refused Enter's default unconditionally and MultiSelect answered a
 * closed-list Enter by opening the list, so a form whose last field was a
 * picker could never be submitted from the keyboard (`FJS-2789`).
 */
export const name = 'Enter in a picker: take a row while open, submit once closed'
export const covers = ['forms/Combobox', 'forms/MultiSelect']

const read = (id) => `document.querySelector('#${id}').textContent`

export async function run(t) {
  await t.mount('picker-enter-submits')

  /* ── Combobox ─────────────────────────────────────────────────────── */

  // Focus opens the list; Enter takes the active row and must not also submit.
  await t.clickAt('#f input[role=combobox]')
  await t.evaluate(`return await waitVisible('#f [role=option]');`)
  await t.press('Enter')
  await t.eventually(read('value'), 'a', 'Combobox: Enter on an open list picks the active row')
  await t.eventually(read('submits'), '0', 'and does not submit the form')

  await t.press('Enter')
  await t.eventually(read('submits'), '1', 'Combobox: Enter on a closed list submits the form')

  // Typing reopens the list, so Enter is the picker's again. The box holds
  // the picked label; select it so the typing replaces it.
  await t.evaluate(`document.querySelector('#f input[role=combobox]').select()`)
  await t.type('Br')
  await t.evaluate(`return await waitVisible('#f [role=option]');`)
  await t.press('Enter')
  await t.eventually(read('value'), 'b', 'Combobox: Enter after typing picks the filtered row')
  await t.eventually(read('submits'), '1', 'and does not submit')

  await t.press('Escape')
  await t.press('Enter')
  await t.eventually(read('submits'), '2', 'Combobox: Enter after Escape closed the list submits')

  /* ── MultiSelect ──────────────────────────────────────────────────── */

  // A multiple picker stays open after a pick, so closing it is Escape.
  await t.clickAt('#m input')
  await t.evaluate(`return await waitVisible('#m [role=option]');`)
  await t.press('Enter')
  await t.eventually(read('values'), 'a', 'MultiSelect: Enter on an open list adds the active row')
  await t.eventually(read('multi-submits'), '0', 'and does not submit the form')

  await t.press('Escape')
  await t.press('Enter')
  await t.eventually(read('multi-submits'), '1', 'MultiSelect: Enter on a closed list submits the form')
  await t.eventually(`document.querySelectorAll('#m [role=option]').length`, 0,
    'without opening the list')
}
