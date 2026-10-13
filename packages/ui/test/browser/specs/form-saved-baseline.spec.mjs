/*
 * form-saved-baseline.spec.mjs — reset() after a save goes back to the SAVED row.
 *
 * The baseline was moved only by reset(next), so after a save it still held
 * the row as opened: reset put the old values and the old @version back, and
 * the next save carried v4 again — under `auto` that writes the person's own
 * edit away, under @version it is a 409 against a revision this screen passed
 * (`FJS-2584`). Each claim is paired with its control: a reset before any save
 * still goes back to the opened row, and a column the boundary kept resets to
 * what is stored, not to what was typed.
 */
export const name = 'Form — the baseline after a save'
export const covers = ['forms/Form']

const value = (sel) => `document.querySelector(${JSON.stringify(sel)}).value`
const text  = (id) => `document.querySelector('#${id}').textContent`

async function typeInto(t, sel, v) {
  await t.evaluate(`
    const el = document.querySelector(${JSON.stringify(sel)});
    el.focus();
    el.value = ${JSON.stringify(v)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
}

export async function run(t) {
  await t.mount('form-saved-baseline')

  // The control: nothing saved, so a reset is the row as opened.
  await typeInto(t, '#saved [name=reference]', 'scratch')
  await t.clickAt('#reset')
  await t.eventually(value('#saved [name=reference]'), 'Ada', 'before a save, reset goes back to the opened row')

  await typeInto(t, '#saved [name=reference]', 'Grace')
  await typeInto(t, '#saved [name=note]', 'typed')
  await t.clickAt('#submit')
  await t.eventually(text('calls'), 'auto:v4:Grace', 'the first save carries the revision it read')

  await t.clickAt('#reset')
  await t.eventually(value('#saved [name=reference]'), 'Grace', 'after a save, reset keeps the saved value')
  await t.eventually(value('#saved [name=note]'), 'stored',
    'and a column the boundary kept resets to what is stored, not to what was typed')

  await typeInto(t, '#saved [name=reference]', 'Lin')
  await t.clickAt('#submit')
  await t.eventually(text('calls'), 'auto:v4:Grace|auto:v5:Lin',
    'the next save carries the revision the last one minted, not the one it was opened at')

  // An onsubmit answering no row: the sent record is the baseline.
  await typeInto(t, '#hand [name=reference]', 'Hand')
  await t.clickAt('#hand-submit')
  await t.eventually(text('hand-calls'), 'Hand', 'the hand-written write ran')
  await typeInto(t, '#hand [name=reference]', 'scratch')
  await t.clickAt('#hand-reset')
  await t.eventually(value('#hand [name=reference]'), 'Hand', 'with no row answered, reset keeps what was sent')
}
