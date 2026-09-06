/*
 * bind:value on a numeric control — FJS-857.
 *
 * The write direction (code → element) always worked, so a round trip driven
 * from code agrees with a string. Only a real keystroke through a real input
 * event can see what the variable ends up holding, and happy-dom keeps no
 * `valueAsNumber` worth asking.
 */
export const name = 'bind:value coerces a numeric input (FJS-857)'
export const covers = ['bind-value', 'input-type-number']

export async function run(t) {
  await t.mount('bind-number')

  t.is(await t.evaluate(`return document.querySelector('#qty-type').textContent;`), 'number',
    'the initial value is the number the component wrote')

  await t.clickAt('#qty')
  await t.evaluate(`document.querySelector('#qty').select(); return true;`)
  await t.type('12')
  await t.eventually(`document.querySelector('#qty-type').textContent`, 'number',
    'a typed value stays a number')
  t.is(await t.evaluate(`return document.querySelector('#qty-plus').textContent;`), '13',
    'so arithmetic on it adds rather than concatenates')

  // An empty box is "no value yet", not zero and not the string it reads as.
  await t.evaluate(`document.querySelector('#qty').select(); return true;`)
  await t.press('Backspace')
  await t.eventually(`document.querySelector('#qty-type').textContent`, 'undefined',
    'an emptied number input yields undefined')
  t.is(await t.evaluate(`return document.querySelector('#qty').value;`), '',
    'and the box stays empty rather than being written back over')

  // A range slider is the same class of control and was the same defect.
  await t.evaluate(`
    const el = document.querySelector('#vol')
    el.value = '8'
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  `)
  await t.eventually(`document.querySelector('#vol-type').textContent`, 'number',
    'a range input is coerced too')

  // The control: a text input still hands over its string.
  await t.clickAt('#text')
  await t.type('7')
  await t.eventually(`document.querySelector('#text-val').textContent`, 'a7',
    'a text input still appends')
  t.is(await t.evaluate(`return document.querySelector('#text-type').textContent;`), 'string',
    'and still holds a string, which is what its type means')
}
