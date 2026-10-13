/*
 * combobox-typed.spec.mjs — a picker whose typed words are a choice of their
 * own, and a picker whose rows a server search answers.
 *
 * The words were the control's private state and Enter always took the
 * highlighted row, so a picker that also adds what was typed stated a
 * made-up FIRST option and read the words off the input through `oninput` —
 * Enter then never took the match (`FJS-2799`). `allowNew` now offers the
 * words as the LAST row, `onquery` hands them out, `oncreate` says a value
 * was minted, and a stated `search` draws its answer without filtering it
 * again by label.
 */
export const name = 'a combobox: the typed words as the last row, and a server search drawn as answered'
export const covers = ['forms/Combobox']

const read = (id) => `document.querySelector('#${id}').textContent`
const rows = (root) => `[...document.querySelectorAll('${root} [role=option]')].map(r => r.textContent.trim()).join('|')`

export async function run(t) {
  await t.mount('combobox-typed')

  /* ── Enter takes the first match ──────────────────────────────────── */

  await t.clickAt('#pick input[role=combobox]')
  await t.type('mow')
  await t.eventually(read('words'), 'mow', 'onquery hands out the words as they are typed')
  await t.eventually(rows('#pick'), 'Mowing|Add “mow” as a custom line',
    'the match first, the typed words last')
  await t.eventually(`document.querySelector('#pick [data-active]')?.textContent.trim()`, 'Mowing',
    'and the cursor starts on the match')
  await t.press('Enter')
  await t.eventually(read('picked'), '1', 'Enter takes the first match')
  await t.eventually(read('created'), 'none', 'and mints nothing')

  /* ── the words, reached with ↓ ────────────────────────────────────── */

  await t.evaluate(`document.querySelector('#pick input[role=combobox]').select()`)
  await t.type('mu')
  await t.eventually(rows('#pick'), 'Mulch install|Add “mu” as a custom line', 'the list follows the new words')
  await t.press('ArrowDown')
  await t.eventually(`document.querySelector('#pick input[role=combobox]').getAttribute('aria-activedescendant') === document.querySelector('#pick [data-new]').id`,
    true, 'one ↓ names the typed row as the active descendant')
  await t.press('Enter')
  await t.eventually(read('created'), 'mu', 'Enter on it mints the words')
  await t.eventually(read('order'), 'change,create,change', 'oncreate fires before onchange')
  await t.eventually(read('picked'), 'mu', 'and the value is the text')

  /* ── nothing matches: the words are the only row ──────────────────── */

  await t.evaluate(`document.querySelector('#pick input[role=combobox]').select()`)
  await t.type('Edging')
  await t.eventually(rows('#pick'), 'Add “Edging” as a custom line', 'with no match the typed row is the list')
  await t.press('Enter')
  await t.eventually(read('created'), 'Edging', 'and Enter mints it')

  /* ── text that IS a row's label is not offered again ──────────────── */

  await t.evaluate(`document.querySelector('#pick input[role=combobox]').select()`)
  await t.type('aeration')
  await t.eventually(rows('#pick'), 'Aeration', 'a label typed whole is the row, not a second one')

  /* ── the ✕ empties the box without an input event ────────────────── */

  await t.clickAt('#pick button[aria-label=Clear]')
  await t.eventually(read('words'), '', 'onquery hears the clear')
  // The clear hands the focus back, which opens the list over what is below.
  await t.press('Escape')
  await t.eventually(`document.querySelectorAll('#pick [role=listbox]').length`, 0, 'and Escape closes the list')

  /* ── a stated search: rows drawn as answered ──────────────────────── */

  await t.clickAt('#search input[role=combobox]')
  await t.type('lawn')
  await t.eventually(read('asked'), 'lawn', 'the words go to the search once the typing stops')
  await t.eventually(rows('#search'), 'Mowing|Aeration',
    'its rows are drawn though no label holds the words')
  await t.press('Enter')
  await t.eventually(read('found'), '1', 'and Enter takes the first of them')

  await t.evaluate(`document.querySelector('#search input[role=combobox]').select()`)
  await t.press('Backspace')
  await t.eventually(rows('#search'), 'Mowing|Mulch install|Aeration', 'an empty box is the stated list again')
  await t.eventually(read('asked'), 'lawn', 'and asks the search nothing')
}
