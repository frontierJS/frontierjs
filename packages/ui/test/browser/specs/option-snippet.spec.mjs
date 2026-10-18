/*
 * option-snippet.spec.mjs — a picture or a second line per option in
 * RadioGroup, Combobox and MultiSelect (`FJS-2673`).
 *
 * Their options were { value, label, description? } and nothing else, so a
 * choice that IS a picture (a rating scale's stars or faces) or needs a price
 * under its name had to be joined into one label string. An `option` snippet
 * draws the row from the caller's own object, and a `description` is drawn
 * under the label without one.
 */
export const name = 'pickers: an option snippet and a description per row'
export const covers = ['forms/RadioGroup', 'forms/Combobox', 'forms/MultiSelect']

const text = (sel) => `[...document.querySelectorAll('${sel}')].map(e => e.textContent.trim()).join('|')`

export async function run(t) {
  await t.mount('option-snippet')

  /* ── RadioGroup ───────────────────────────────────────────────────── */

  await t.eventually(text('#radio .glyph'), '★|☺', 'a card draws the snippet, with a field the kit does not know')
  await t.eventually(text('#radio-segmented .glyph'), '★|☺', 'and so does the segmented row')
  await t.eventually(`document.querySelectorAll('#radio .glyph')[1].closest('label').querySelector('input').value`, 'faces',
    'the picture sits inside the label of its radio')
  await t.clickAt('#radio .fjs-radio-card:nth-of-type(2)')
  await t.eventually(`document.querySelector('#scale').textContent`, 'faces', 'clicking the picture picks it')

  /* ── Combobox ─────────────────────────────────────────────────────── */

  await t.clickAt('#combo-snippet input[role=combobox]')
  await t.eventually(text('#combo-snippet [role=option] .price'), '$45.00|$80.00', 'a row draws the snippet')
  await t.clickAt('#combo-snippet [role=option]:nth-of-type(2)')
  await t.eventually(`document.querySelector('#offer').textContent`, '2', 'a snippet row still picks')
  await t.eventually(`document.querySelector('#combo-snippet input').value`, 'Aeration',
    'and the box shows the label, not the snippet')

  await t.clickAt('#combo-plain input[role=combobox]')
  await t.eventually(text('#combo-plain [role=option] .field-hint'), 'Per week|Per year',
    'no snippet: the description is drawn under the label')

  /* ── MultiSelect ──────────────────────────────────────────────────── */

  await t.clickAt('#multi-snippet input')
  await t.eventually(text('#multi-snippet [role=option] .price'), '$45.00|$80.00', 'a row draws the snippet')

  await t.clickAt('#multi-plain input')
  await t.eventually(text('#multi-plain [role=option] .field-hint'), 'Per week|Per year',
    'no snippet: the description is drawn under the label')
}
