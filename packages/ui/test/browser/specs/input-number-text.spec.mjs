/*
 * input-number-text.spec.mjs — a number Input handed its own text back (FJS-4183).
 *
 * The caller's `value={text} oninput={e => text = e.target.value}` makes the
 * value flip between the caller's string and the kit's number. Redrawing the
 * box from the new value while it already holds that number wipes the point
 * typed after `8`, so `8.25` reads `825`.
 */
export const name = 'Input type=number, callback style'
export const covers = ['forms/Input']

export async function run(t) {
  await t.mount('input-number-text')

  await t.evaluate(`const el = document.querySelector('#scaled'); el.value = ''; el.focus(); return true;`)
  await t.type('8.25')
  t.is(await t.evaluate(`return document.querySelector('#scaled').value;`), '8.25', 'typing 8.25 leaves 8.25 in the box')
  await t.eventually(`document.querySelector('#scaled-value').textContent`, '8.25', 'and the caller holds 8.25')
}
