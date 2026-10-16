/*
 * form-sealed-picker.spec.mjs — a frozen foreign key shows the row's name.
 *
 * `@immutable` on a relation is frozen on every row that exists, and the edit
 * form draws its picker disabled. It read the raw key where the live picker
 * reads a name (`FJS-1542`).
 */
export const name = 'Form — a frozen relation'
export const covers = ['forms/Form', 'forms/Combobox']

const box = (root) => `document.querySelector('${root} input[role=combobox]')?.value ?? ''`

export async function run(t) {
  await t.mount('form-sealed-picker')

  t.ok(await t.evaluate(`return !!document.querySelector('#frozen input[role=combobox]')?.disabled;`),
    'the frozen relation is disabled')

  await t.eventually(box('#frozen'), 'Staging',
    'and shows the related row\'s name, not its key')
}
