/*
 * textarea-autogrow.spec.mjs -- an autogrow Textarea follows its value, not
 * only the keystrokes.
 *
 * `FJS-2639`: typing wrote an inline height, and a value written from code
 * fires no input event, so a composer cleared after a send kept the box at
 * the height of the message it had just sent. Height is layout, so only a
 * real browser can answer.
 */
export const name   = 'Textarea autogrow'
export const covers = ['forms/Textarea']

const HEIGHT = `document.querySelector('#note').getBoundingClientRect().height`

export async function run(t) {
  await t.mount('textarea-autogrow')
  const empty = await t.evaluate(`return ${HEIGHT};`)

  await t.clickAt('#note')
  await t.type('a')
  for (let i = 0; i < 6; i++) await t.press('Enter')
  await t.type('b')
  await t.eventually(`${HEIGHT} > ${empty + 20}`, true, 'typing lines grows the box')

  await t.clickAt('#stage #clear')
  await t.eventually(`Math.abs(${HEIGHT} - ${empty}) < 2`, true,
    'clearing the value from code shrinks the box back to its empty height')

  await t.clickAt('#stage #fill')
  await t.eventually(`${HEIGHT} > ${empty + 20}`, true, 'and a value written from code grows it again')
}
