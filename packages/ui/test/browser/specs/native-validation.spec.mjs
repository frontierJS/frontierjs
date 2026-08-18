/*
 * A native constraint inside a form the kit does not own (`FJS-055`).
 *
 * Kit controls carry a real `required` on purpose — that attribute is what
 * assistive tech announces. The cost is that the browser then refuses to fire
 * `submit` and shows its own bubble, which reads as a broken submit handler
 * and says nothing. `<Form>` is novalidate by default, so what remained was
 * the hand-written `<form>`; it is now reported by name.
 */
export const name = 'native validation in a hand-written form (FJS-055)'
export const covers = ['forms/Input']

export async function run(t) {
  await t.mount('native-validation')

  const warnings = await t.evaluate('return { v: window.kitWarnings.slice() };').then((r) => r.v)
  const ours = warnings.filter((w) => w.includes('[@frontierjs/ui]') && w.includes('native constraint'))

  t.is(ours.length, 1, 'exactly one form is reported — once per form, not once per control')
  t.ok(ours[0].includes('bareField'), 'and it names the field that is blocking submit')
  t.ok(ours[0].includes('novalidate'), 'and says what to do about it')

  t.ok(!ours.some((w) => w.includes('optedField')),
    'a form marked data-native-validation asked for the browser UI and is left alone')
  t.ok(!ours.some((w) => w.includes('quietField')),
    'and a novalidate form has nothing to report')

  // The warning is a report, not a change of behaviour: the constraint is
  // still on the element, because that is what makes it announceable.
  const state = await t.evaluate(`
    const el = document.querySelector('[name=bareField]');
    return { required: el.required, valid: el.validity.valid, willValidate: el.willValidate };
  `)
  t.is(state.required, true, 'the native required is still there')
  t.is(state.valid, false, 'and still unsatisfied — nothing was silently relaxed')
}
