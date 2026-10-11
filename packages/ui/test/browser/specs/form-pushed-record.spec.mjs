/*
 * form-pushed-record.spec.mjs — `<Form record={row} bind:dirty>` keeps the
 * first keystroke.
 *
 * The first edit flips `dirty`, which is parent state through the binding, so
 * the parent re-renders and pushes `record` again — the same row it handed in.
 * Taken as a new record, that push put "old" back over the "n" just typed, the
 * caret sat at the end, and "new" went out as "oldew" (`FJS-2589`). The only
 * other `bind:dirty` fixture binds `record` too, and a bound record is the
 * form's own draft coming back, so it never showed.
 *
 * The pair: a row that IS different must still replace the draft, or the fix
 * is a form that ignores its caller.
 */
export const name = 'Form — a re-pushed record does not undo an edit'
export const covers = ['forms/Form']

const BOX = '#form [name=name]'

export async function run(t) {
  await t.mount('form-pushed-record')

  t.is(await t.evaluate(`return document.querySelector('${BOX}').value;`), 'old',
    'the form opens on the row it was handed')

  // Real keystrokes over a selection: the push lands between "n" and "e".
  await t.clickAt(BOX)
  await t.evaluate(`document.querySelector('${BOX}').select(); return true;`)
  await t.type('new')
  await t.eventually(`document.getElementById('dirty').textContent`, 'dirty',
    'the first keystroke reaches the parent through bind:dirty')
  await t.eventually(`document.querySelector('${BOX}').value`, 'new',
    'and the box still holds what was typed')

  await t.evaluate(`document.querySelector('#form form').requestSubmit(); return true;`)
  await t.eventually(`window.kitSent().length`, 1, 'the form saves')
  t.is(await t.evaluate(`return window.kitSent()[0].name;`), 'new',
    'what was typed is what was sent')

  // A genuinely different row still wins over the draft.
  await t.evaluate(`window.kitSelect({ id: 'i-2', name: 'other' }); return true;`)
  await t.eventually(`document.querySelector('${BOX}').value`, 'other',
    'a different row pushed in replaces the draft')
}
