/*
 * combobox-late-options.spec.mjs — a combobox shows its value's LABEL when the
 * list comes second.
 *
 * The text box was labelled once, at mount, from whatever list it had — on an
 * edit form that is none, because `form.optionsFor` has not answered — and
 * re-labelled only when the VALUE changed. So every relation on every edit
 * screen read its raw foreign key, and the key, being the search text,
 * filtered the open list to nothing: *Showing 0 of 3* (`FJS-1443`).
 *
 * Both doors a list reaches the control by: fetched by a <Form>, and passed in
 * by the caller once it has it. And a list whose labels are numbers, which
 * took the page down on the first pick.
 */
export const name = 'a combobox whose options arrive after its value'
export const covers = ['forms/Combobox']

const box = (root) => `document.querySelector('${root} input[role=combobox]')?.value ?? ''`

export async function run(t) {
  await t.mount('combobox-late-options')

  await t.eventually(box('#fetched'), 'Bravo',
    'options a form fetched — the box shows the row\'s label once the request answers, not its id')

  await t.clickAt('#load')
  await t.eventually(box('#passed'), 'South',
    'options passed after mount — the box shows the label, not the id')

  // Opening the list after the label landed: the label is the search text,
  // and it matches its own row rather than filtering everything away.
  await t.clickAt('#fetched input[role=combobox]')
  await t.eventually(`document.querySelectorAll('#fetched [role=option]').length`, 1,
    'and the open list holds the selected row, not nothing')

  /* ── a label that is a number ─────────────────────────────────────── */

  await t.clickAt('#numeric input[role=combobox]')
  await t.evaluate(`return await waitVisible('#numeric [role=option]');`)
  await t.clickAt('#numeric [role=option]')
  await t.eventually(`document.querySelector('#picked').textContent`, '7',
    'choosing a row whose label is a number sets the value')
  await t.eventually(box('#numeric'), '7', 'and shows it as text')

  // The filter runs on the next keystroke; a number in `query` threw there.
  await t.clickAt('#numeric input[role=combobox]')
  await t.type('8')
  await t.eventually(`document.querySelector('#picked').textContent`, '7',
    'and typing after it filters rather than throwing')
}
