/*
 * picker-clear.spec.mjs — clearing a single-value picker announces null.
 *
 * Invariant 9: an explicit null clears. A clear that announced `undefined`
 * was dropped by JSON.stringify, so the PATCH omitted the column and the
 * relation the user had just cleared was still there on reload (`FJS-2587`).
 * Each `<output>` holds the wire a PATCH of the announced value would carry.
 */
export const name = 'clearing a single-value picker announces null'
export const covers = ['forms/Combobox', 'forms/MultiSelect']

const out = (root) => `document.querySelector('${root} output').textContent`
const CLEARED = '{"customerId":null}'

export async function run(t) {
  await t.mount('picker-clear')

  await t.clickAt('#combo button[aria-label=Clear]')
  await t.eventually(out('#combo'), CLEARED, 'the combobox × sends the column as null')

  // A locked combobox offers no ×. The input was disabled and the button was
  // not, so on a sealed document a press emptied an `@immutable` relation and
  // its required rule then refused every other edit on the form.
  t.is(await t.evaluate(`return !!document.querySelector('#locked button[aria-label=Clear]')`), false,
    'a disabled combobox draws no × to clear it')

  await t.clickAt('#multi [aria-label="Remove South"]')
  await t.eventually(out('#multi'), CLEARED, 'removing a single MultiSelect\'s chip sends the column as null')

  // Deleting the text is the other way a combobox is emptied. Last, because
  // it opens the list over whatever sits below it.
  await t.evaluate(`
    const el = document.querySelector('#typed input[role=combobox]')
    el.value = ''
    el.dispatchEvent(new Event('input', { bubbles: true }))
  `)
  await t.eventually(out('#typed'), CLEARED, 'emptying the combobox text sends the column as null')
}
