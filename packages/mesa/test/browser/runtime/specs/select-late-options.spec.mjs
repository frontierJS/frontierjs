/*
 * A select shows its bound value when the options arrive after the value.
 *
 * `bind:value` on a select applied the value when the VALUE changed, and never
 * when the OPTIONS did. An edit screen's pickers load their options after the
 * row, so every one of them showed its first option or its placeholder, and a
 * person correcting what they saw overwrote what was stored (`FJS-1320`).
 *
 * In a real browser because the failure is the browser's own choice: a select
 * given options with nothing selected selects the first one it can.
 */
export const name = 'select, options after the value'
export const covers = ['bindInput']

export async function run(t) {
  await t.mount('select-late-options')

  const val = (id) => `document.querySelector('#${id}').value`
  const picked = (id) => `[...document.querySelector('#${id}').selectedOptions].map((o) => o.value).join()`

  await t.clickAt('#load')
  await t.eventually(val('bare'), 'c', 'the options arrived later and the bound value is selected, not the first option')
  await t.eventually(val('placeholder'), 'c', 'and a placeholder ahead of them does not hold the selection')
  await t.eventually(picked('multi'), 'b,c', 'a multiple select selects every bound value')

  // An unkeyed each rebinds its rows in place: the same three options, each
  // with a new value, and the selected one — the third — now says b. Nothing
  // is added or removed, so only the values changing can say so.
  await t.clickAt('#shift')
  await t.eventually(val('bare'), 'c', 'an option whose value changed in place is re-read')
  await t.eventually(val('placeholder'), 'c', 'and with a placeholder')
  await t.eventually(picked('multi'), 'c,b', 'the multiple select follows its values to their new options')

  t.is(await t.evaluate(`return document.querySelector('#state').textContent;`), 'c',
    'and the bound variable was never written by the browser picking for itself')
}
